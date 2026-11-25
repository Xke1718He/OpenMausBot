import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Client, type EventDispatcher } from "@larksuiteoapi/node-sdk";
import { FeishuTransport, feishuHttpInstance } from "../feishu/transport.ts";
import type { FeishuConfig } from "../feishu/config.ts";
import { LarkCliFixture } from "./lark-cli-fixture.ts";

interface FakeFeishuResource {
  bytes: Buffer;
  mime: string;
  status?: number;
  declaredBytes?: number;
  size?: number;
  ignoreRange?: boolean;
  failRangeOnce?: number;
  failRange?: number;
  corruptRangeAt?: number;
  shiftRangeAt?: number;
  rangeChunkDelayMs?: number;
  emptyRange?: boolean;
  probeStatus?: number;
}

export class FakeFeishu {
  readonly cards = new Map<string, { sourceId: string; content: Record<string, unknown> }>();
  readonly cardUpdates: { messageId: string; content: Record<string, unknown> }[] = [];
  readonly resources = new Map<string, FakeFeishuResource>();
  readonly folders = new Map<string, { items: unknown[]; all_count?: string | number; status?: number }>();
  readonly downloads: { messageId: string; key: string; type: string | null; range?: string }[] = [];
  readonly probes: { messageId: string; key: string }[] = [];
  readonly folderRequests: { messageId: string; key: string }[] = [];
  readonly replies: { messageId: string; text: string; uuid: string; inThread: boolean; requestBytes: number }[] = [];
  private readonly sent = new Map<string, string>();
  private readonly server: Server;
  private dispatcher?: EventDispatcher;
  private origin = "";
  readonly cli = new LarkCliFixture();
  failNextReply = false;

  constructor() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> : {};
      const answer = (status: number, result: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(result)); };
      const requestBytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
      if (requestBytes > 30_000) return answer(400, { code: 230025, msg: "Fixture message exceeds the post limit" });
      if (req.url?.includes("access_token/internal")) return answer(200, { code: 0, tenant_access_token: "fake-tenant", app_access_token: "fake-app", expire: 7200 });
      if (req.url?.includes("/oauth/token")) return answer(200, { access_token: "fake-tenant", token_type: "Bearer", expires_in: 7200 });
      if (req.url === "/open-apis/bot/v3/info") return answer(200, { code: 0, bot: { open_id: "ou_bot", activate_status: 2 } });
      const folder = /^\/open-apis\/im\/v1\/files\/([^/]+)\/folder(?:\?|$)/.exec(req.url ?? "");
      if (folder && req.headers.authorization === "Bearer fake-tenant") {
        const params = new URL(req.url!, "http://fixture").searchParams;
        this.folderRequests.push({ messageId: params.get("srcid") ?? "", key: folder[1]! });
        const entry = this.folders.get(`${params.get("srcid")}:${folder[1]}`);
        if (params.get("srctype") !== "message" || params.get("recursive") !== "true") return answer(400, { code: 1 });
        if (!entry || entry.status) return answer(entry?.status ?? 404, { code: entry?.status === 403 ? 234009 : 234005 });
        const count = (items: unknown[]): number => items.reduce<number>((total, item) => total + 1 + count((item as { children?: unknown[] }).children ?? []), 0);
        return answer(200, { code: 0, data: { items: entry.items, all_count: entry.all_count ?? count(entry.items) + 1 } });
      }
      const patch = /^\/open-apis\/im\/v1\/messages\/([^/?]+)$/.exec(req.url ?? "");
      if (req.method === "PATCH" && patch && req.headers.authorization === "Bearer fake-tenant") {
        const card = this.cards.get(patch[1]!);
        if (!card) return answer(404, { code: 1 });
        card.content = JSON.parse(String(body.content));
        this.cardUpdates.push({ messageId: patch[1]!, content: card.content });
        return answer(200, { code: 0 });
      }
      const resource = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/resources\/([^/?]+)/.exec(req.url ?? "");
      if (resource && req.headers.authorization === "Bearer fake-tenant") {
        const url = new URL(req.url!, "http://fixture");
        const range = req.headers.range;
        if (range === "bytes=0-0") this.probes.push({ messageId: resource[1]!, key: resource[2]! });
        else this.downloads.push({ messageId: resource[1]!, key: resource[2]!, type: url.searchParams.get("type"), ...(range ? { range } : {}) });
        const file = this.resources.get(`${resource[1]}:${resource[2]}`);
        if (!file || file.status) return answer(file?.status ?? 404, { code: file?.status === 403 ? 234009 : 234005, msg: "Fixture resource refused" });
        if (range === "bytes=0-0" && file.probeStatus) return answer(file.probeStatus, { code: 1 });
        if (range && file.emptyRange) {
          res.writeHead(206, { "content-type": file.mime, "content-length": 0, "content-range": "bytes */0" }); res.end(); return;
        }
        if (file.size === undefined && file.bytes.length === 0) {
          res.writeHead(range ? 206 : 200, { "content-type": file.mime, "content-length": 0, ...(range ? { "content-range": "bytes */0" } : {}) });
          res.end(); return;
        }
        if (!range && (file.size ?? file.bytes.length) > 100 * 1024 * 1024) return answer(400, { code: 234037, msg: "Please use Range for resources over 100 MB" });
        if (range && !file.ignoreRange) {
          const total = file.size ?? file.bytes.length;
          const bounds = /^bytes=(\d+)-(\d+)$/.exec(range);
          const start = Number(bounds?.[1]), end = Math.min(total - 1, Number(bounds?.[2]));
          if (!bounds || start > end || start >= total || end - start + 1 > 32 * 1024 * 1024) return answer(400, { code: 234046 });
          if (file.failRange === start) return answer(503, { code: 1 });
          if (file.failRangeOnce === start) { file.failRangeOnce = undefined; return answer(503, { code: 1 }); }
          const bytes = file.size === undefined ? file.bytes.subarray(start, end + 1) : Buffer.alloc(end - start + 1, 97);
          res.writeHead(206, { "content-type": file.mime, "content-length": bytes.length, "content-range": `bytes ${start + (file.shiftRangeAt === start ? 1 : 0)}-${end}/${total + (file.corruptRangeAt === start ? 1 : 0)}` });
          if (file.rangeChunkDelayMs) {
            for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
              if (res.destroyed) return;
              res.write(bytes.subarray(offset, offset + 64 * 1024));
              await new Promise(resolve => setTimeout(resolve, file.rangeChunkDelayMs));
            }
            res.end(); return;
          }
          res.end(bytes); return;
        }
        res.writeHead(200, { "content-type": file.mime, "content-length": file.declaredBytes ?? file.bytes.length });
        res.end(file.bytes); return;
      }
      const target = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(req.url ?? "");
      if (target && req.headers.authorization === "Bearer fake-tenant") {
        const uuid = String(body.uuid);
        const known = this.sent.get(uuid);
        const messageId = known ?? `om_reply_${this.sent.size}`;
        if (!known) {
          this.sent.set(uuid, messageId);
          if (body.msg_type === "interactive") {
            this.cards.set(messageId, { sourceId: target[1]!, content: JSON.parse(String(body.content)) });
          } else {
            const content = JSON.parse(String(body.content)) as { zh_cn: { content: { text: string }[][] } };
            this.replies.push({ messageId: target[1]!, text: content.zh_cn.content[0]![0]!.text, uuid, inThread: body.reply_in_thread === true, requestBytes });
          }
        }
        if (this.failNextReply) { this.failNextReply = false; return answer(503, { code: 1 }); }
        return answer(200, { code: 0, data: { message_id: messageId } });
      }
      answer(404, { code: 1, msg: "Unknown fixture endpoint" });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    await this.cli.listen(this.origin);
  }

  transport(config: FeishuConfig): FeishuTransport {
    const client = new Client({ appId: config.appId, appSecret: "fake-secret", domain: this.origin,
      httpInstance: feishuHttpInstance,
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
    return new FeishuTransport(config, "fake-secret", () => {}, { client, cliDownload: this.cli.options, socket: {
      start: async ({ eventDispatcher }) => { this.dispatcher = eventDispatcher; }, close: () => {},
    } });
  }

  async emit(message: unknown): Promise<void> {
    if (!this.dispatcher) throw new Error("Fixture listener is not started");
    await this.dispatcher.invoke({ schema: "2.0", header: { event_id: randomUUID(), event_type: "im.message.receive_v1", create_time: String(Date.now()), token: "fixture" }, event: message }, { needCheck: false });
  }

  async click(messageId: string, senderId: string, chatId: string, value: unknown): Promise<unknown> {
    if (!this.dispatcher) throw new Error("Fixture listener is not started");
    return this.dispatcher.invoke({ schema: "2.0", header: { event_id: randomUUID(), event_type: "card.action.trigger" }, event: {
      operator: { open_id: senderId }, context: { open_message_id: messageId, open_chat_id: chatId }, action: { tag: "button", value },
    } }, { needCheck: false });
  }

  async close(): Promise<void> {
    await this.cli.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}
