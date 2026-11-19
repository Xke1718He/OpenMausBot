import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { Client, type EventDispatcher } from "@larksuiteoapi/node-sdk";
import { FeishuTransport, feishuHttpInstance } from "../feishu/transport.ts";
import type { FeishuConfig } from "../feishu/config.ts";

export class FakeFeishu {
  readonly replies: { messageId: string; text: string; uuid: string; inThread: boolean; requestBytes: number }[] = [];
  private readonly sent = new Map<string, string>();
  private readonly server: Server;
  private dispatcher?: EventDispatcher;
  private origin = "";
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
      if (req.url === "/open-apis/bot/v3/info") return answer(200, { code: 0, bot: { open_id: "ou_bot", activate_status: 2 } });
      const target = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(req.url ?? "");
      if (target && req.headers.authorization === "Bearer fake-tenant") {
        const uuid = String(body.uuid);
        const known = this.sent.get(uuid);
        const messageId = known ?? `om_reply_${this.sent.size}`;
        if (!known) {
          this.sent.set(uuid, messageId);
          const content = JSON.parse(String(body.content)) as { zh_cn: { content: { text: string }[][] } };
          this.replies.push({ messageId: target[1]!, text: content.zh_cn.content[0]![0]!.text, uuid, inThread: body.reply_in_thread === true, requestBytes });
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
  }

  transport(config: FeishuConfig): FeishuTransport {
    const client = new Client({ appId: config.appId, appSecret: "fake-secret", domain: this.origin,
      httpInstance: feishuHttpInstance,
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
    return new FeishuTransport(config, "fake-secret", () => {}, { client, socket: {
      start: async ({ eventDispatcher }) => { this.dispatcher = eventDispatcher; }, close: () => {},
    } });
  }

  async emit(message: unknown): Promise<void> {
    if (!this.dispatcher) throw new Error("Fixture listener is not started");
    await this.dispatcher.invoke({ schema: "2.0", header: { event_id: randomUUID(), event_type: "im.message.receive_v1", create_time: String(Date.now()), token: "fixture" }, event: message }, { needCheck: false });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
}
