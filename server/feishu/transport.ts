import { Client, Domain, EventDispatcher, LoggerLevel, WSClient, defaultHttpInstance, type HttpInstance, type Logger } from "@larksuiteoapi/node-sdk";
import { z } from "zod";
import { type ChatAttachment, type ChatDelivery, type ChatDownloadedAttachment, type ChatMessage, type ChatAttachmentExpansion, type ChatTaskControl, type ChatTaskView } from "../messaging/contracts.ts";
import { chatHash } from "../messaging/state.ts";
import type { FeishuConfig } from "./config.ts";
import { feishuMarkdownParts, feishuPostContent } from "./markdown.ts";
import { feishuTaskCard, feishuTaskControl } from "./task-card.ts";
import { FeishuCliDownloader, type FeishuCliDownloadOptions } from "./cli-download.ts";
import { FeishuResourceMetadata } from "./resource-metadata.ts";
import { feishuBotAction, type FeishuBotAction, type FeishuBotActionResult } from "./bot-card.ts";

const quietLogger: Logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const axios = defaultHttpInstance.create({ timeout: 15_000, maxRedirects: 0 });
axios.interceptors.response.use(response => (response.config as { $return_headers?: boolean }).$return_headers
  ? { data: response.data, headers: response.headers, status: response.status } : response.data);
// SDK 1.76.0 expects response data; Axios 1.21 types retain AxiosResponse after a response interceptor unwraps it.
export const feishuHttpInstance = axios as unknown as HttpInstance;
const botSchema = z.object({ code: z.literal(0), bot: z.object({ open_id: z.string().regex(/^ou_[\w-]+$/), activate_status: z.literal(2) }) });
export type FeishuApi = Pick<Client, "request" | "tokenManager"> & { im: { message: Pick<Client["im"]["message"], "reply" | "patch"> } };

export class FeishuTransport implements ChatDelivery {
  private readonly client: FeishuApi;
  private readonly socket: Pick<WSClient, "start" | "close">;
  private failed = false;
  private readonly cardWrites = new Map<string, number>();
  private readonly downloader: FeishuCliDownloader;
  private readonly metadata: FeishuResourceMetadata;

  constructor(config: FeishuConfig, secret: string, log: (message: string) => void, deps?: { client?: FeishuApi; socket?: Pick<WSClient, "start" | "close">; cliDownload?: FeishuCliDownloadOptions; onState?: (state: "connecting" | "connected" | "reconnecting" | "error") => void }) {
    const options = { appId: config.appId, appSecret: secret, domain: config.domain === "lark" ? Domain.Lark : Domain.Feishu,
      logger: quietLogger, loggerLevel: LoggerLevel.error,
      httpInstance: feishuHttpInstance,
    };
    this.client = deps?.client ?? new Client(options);
    this.metadata = new FeishuResourceMetadata(this.client);
    this.downloader = new FeishuCliDownloader(config, async () => z.string().min(1).parse(await this.client.tokenManager.getTenantAccessToken()), deps?.cliDownload,
      (message, attachment, signal) => this.metadata.size(message, attachment, signal));
    this.socket = deps?.socket ?? new WSClient({ ...options, autoReconnect: true,
      onReady: () => { deps?.onState?.("connected"); log("Feishu connected"); }, onReconnecting: () => { deps?.onState?.("reconnecting"); log("Feishu reconnecting"); },
      onReconnected: () => { deps?.onState?.("connected"); log("Feishu reconnected"); }, onError: () => { this.failed = true; deps?.onState?.("error"); log("Feishu connection failed; check app credentials and event subscriptions"); },
    });
  }

  async identity(): Promise<string> {
    let result: unknown;
    try { result = await this.client.request({ method: "GET", url: "/open-apis/bot/v3/info", timeout: 15_000 }); }
    catch { throw new Error("Feishu bot identity could not be loaded; check app credentials and Bot capability"); }
    const parsed = botSchema.safeParse(result);
    if (!parsed.success) throw new Error("Feishu did not return an enabled bot identity");
    return parsed.data.bot.open_id;
  }

  async start(handler: (event: unknown) => void | Promise<void>, control?: (input: ChatTaskControl) => "accepted" | "refused",
    select?: (input: FeishuBotAction) => Promise<FeishuBotActionResult | null>): Promise<void> {
    const dispatcher = new EventDispatcher({ logger: quietLogger }).register({
      "im.message.receive_v1": data => handler(data),
      "card.action.trigger": async (data: unknown) => {
        const selection = feishuBotAction(data);
        if (selection) {
          try {
            const result = await select?.(selection);
            return result ? { toast: { type: "info", content: result.text }, card: { type: "raw", data: result.card } }
              : { toast: { type: "error", content: "无法切换：仅发起人可选择，或此卡片已失效。请重新发送 /bot。" } };
          } catch { return { toast: { type: "error", content: "无法切换 bot，请稍后重新发送 /bot。" } }; }
        }
        const input = feishuTaskControl(data);
        const accepted = input && control?.(input) === "accepted";
        return { toast: { type: accepted ? "info" : "error", content: accepted ? "操作已收到，正在更新任务状态。" : "无法操作：仅发起人可控制当前任务，或此按钮已失效。" } };
      },
    });
    await this.socket.start({ eventDispatcher: dispatcher });
  }

  close(): void { this.downloader.close(); this.metadata.close(); this.socket.close({ force: true }); }
  assertConnection(): void { if (this.failed) throw new Error("Feishu listener stopped; restart after checking credentials and subscriptions"); }

  formatReply(text: string): string[] { return feishuMarkdownParts(text); }

  async download(message: ChatMessage, attachment: ChatAttachment): Promise<ChatDownloadedAttachment> {
    return this.downloader.download(message, attachment);
  }

  async expand(message: ChatMessage, signal: AbortSignal): Promise<ChatAttachmentExpansion> {
    return this.metadata.expand(message, signal);
  }

  async present(message: ChatMessage, view: ChatTaskView, deliveryId: string, messageId?: string): Promise<string> {
    const content = JSON.stringify(feishuTaskCard(view));
    if (messageId) {
      const remaining = 350 - (Date.now() - (this.cardWrites.get(messageId) ?? 0));
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
      this.recordCardWrite(messageId);
      const result = await this.client.im.message.patch({ path: { message_id: messageId }, data: { content } });
      if (result.code !== 0) throw new Error("Feishu task card could not be updated");
      return messageId;
    }
    return this.sendCard(message, feishuTaskCard(view), deliveryId);
  }

  async sendCard(message: ChatMessage, card: object, deliveryId: string): Promise<string> {
    const result = await this.client.im.message.reply({ path: { message_id: message.id }, data: {
      msg_type: "interactive", content: JSON.stringify(card), reply_in_thread: message.kind === "group", uuid: chatHash([deliveryId]).slice(0, 32),
    } });
    if (result.code !== 0 || !result.data?.message_id) throw new Error("Feishu task card was not acknowledged");
    this.recordCardWrite(result.data.message_id);
    return result.data.message_id;
  }

  private recordCardWrite(messageId: string): void {
    this.cardWrites.delete(messageId);
    this.cardWrites.set(messageId, Date.now());
    if (this.cardWrites.size > 1_000) this.cardWrites.delete(this.cardWrites.keys().next().value!);
  }

  async reply(message: ChatMessage, text: string, deliveryId: string): Promise<void> {
    const result = await this.client.im.message.reply({
      path: { message_id: message.id },
      data: {
        msg_type: "post", content: feishuPostContent(text),
        reply_in_thread: message.kind === "group", uuid: chatHash([deliveryId]).slice(0, 32),
      },
    });
    if (result.code !== 0 || !result.data?.message_id) throw new Error("Feishu did not acknowledge the reply");
  }
}
