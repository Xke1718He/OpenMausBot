import { Client, Domain, EventDispatcher, LoggerLevel, WSClient, defaultHttpInstance, type HttpInstance, type Logger } from "@larksuiteoapi/node-sdk";
import { z } from "zod";
import type { ChatDelivery, ChatMessage } from "../messaging/contracts.ts";
import { chatHash } from "../messaging/state.ts";
import type { FeishuConfig } from "./config.ts";
import { feishuMarkdownParts, feishuPostContent } from "./markdown.ts";

const quietLogger: Logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const axios = defaultHttpInstance.create({ timeout: 15_000, maxRedirects: 0 });
axios.interceptors.response.use(response => response.data);
// SDK 1.76.0 expects response data; Axios 1.21 types retain AxiosResponse after a response interceptor unwraps it.
export const feishuHttpInstance = axios as unknown as HttpInstance;
const botSchema = z.object({ code: z.literal(0), bot: z.object({ open_id: z.string().regex(/^ou_[\w-]+$/), activate_status: z.literal(2) }) });
export type FeishuApi = Pick<Client, "request"> & { im: { message: Pick<Client["im"]["message"], "reply"> } };

export class FeishuTransport implements ChatDelivery {
  private readonly client: FeishuApi;
  private readonly socket: Pick<WSClient, "start" | "close">;
  private failed = false;

  constructor(config: FeishuConfig, secret: string, log: (message: string) => void, deps?: { client?: FeishuApi; socket?: Pick<WSClient, "start" | "close">; onState?: (state: "connecting" | "connected" | "reconnecting" | "error") => void }) {
    const options = { appId: config.appId, appSecret: secret, domain: config.domain === "lark" ? Domain.Lark : Domain.Feishu,
      logger: quietLogger, loggerLevel: LoggerLevel.error,
      httpInstance: feishuHttpInstance,
    };
    this.client = deps?.client ?? new Client(options);
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

  async start(handler: (event: unknown) => void): Promise<void> {
    const dispatcher = new EventDispatcher({ logger: quietLogger }).register({
      "im.message.receive_v1": data => handler(data),
    });
    await this.socket.start({ eventDispatcher: dispatcher });
  }

  close(): void { this.socket.close({ force: true }); }
  assertConnection(): void { if (this.failed) throw new Error("Feishu listener stopped; restart after checking credentials and subscriptions"); }

  formatReply(text: string): string[] { return feishuMarkdownParts(text); }

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
