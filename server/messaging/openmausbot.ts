import { z } from "zod";
import { ChatRuntimeError, type ChatAttachment, type ChatDownloadedAttachment, type ChatRuntime, type ChatStoredAttachment } from "./contracts.ts";
import { Readable } from "node:stream";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { ownedSendSnapshotSchema } from "./owned-send.ts";

const id = z.string().regex(/^[\w-]+$/);
const snapshotSchema = z.object({
  messageId: id, activeLeafId: id.nullable(), activeTurnId: z.string().nullable(), executionId: id.nullable(),
  phase: z.enum(["working", "waiting", "settled", "untracked"]),
  messages: z.array(z.object({ role: z.string(), kind: z.string(), text: z.string().optional(), tool: z.object({ name: z.string(), ok: z.boolean().optional() }).optional(), turnTerminal: z.boolean().optional(), turnSucceeded: z.boolean().optional(), requestCancelled: z.boolean().optional() })),
});

export class OpenMausBotChatRuntime implements ChatRuntime {
  readonly origin: string;
  private readonly botId: string;
  private readonly token: string;
  private readonly publicUrl?: string;
  private readonly downloadDirectory?: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { url: string; botId: string; token: string; publicUrl?: string; downloadDirectory?: string; fetch?: typeof fetch }) {
    const url = new URL(options.url);
    if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Messaging requires an explicit loopback OpenMausBot origin");
    this.origin = url.origin;
    this.botId = id.parse(options.botId);
    this.token = options.token;
    this.publicUrl = options.publicUrl;
    this.downloadDirectory = options.downloadDirectory;
    this.fetcher = options.fetch ?? fetch;
  }

  async connect(): Promise<string> {
    z.object({ app: z.literal("openmausbot"), capabilities: z.object({ ownedMessages: z.literal(1), guardedRequests: z.literal(1) }) }).parse(await this.request("GET", "/api/health"));
    const environment = z.object({ environmentId: z.string(), capabilities: z.object({ cloudHome: z.boolean().optional(), cloudTeam: z.boolean().optional() }) })
      .parse(await this.request("GET", "/.well-known/openmausbot/environment"));
    if (environment.capabilities.cloudHome || environment.capabilities.cloudTeam) throw new Error("This connector is for a local desktop or self-hosted workspace; Cloud requires member identity routing");
    const session = z.object({ scopes: z.array(z.string()) }).parse(await this.request("GET", "/api/auth/session"));
    if (!session.scopes.includes("admin")) throw new Error("The messaging bridge needs an owner/admin paired session");
    const bots = z.object({ bots: z.array(z.object({ id: z.string() })) }).parse(await this.request("GET", "/api/bots?messages=0"));
    if (!bots.bots.some(bot => bot.id === this.botId)) throw new Error("The configured bot is not available to this connection");
    return environment.environmentId;
  }

  async createConversation(title: string): Promise<string> {
    const result = z.object({ task: z.object({ threadId: id }) }).parse(await this.request("POST", `/api/bots/${this.botId}/tasks`, { title, select: false }));
    return result.task.threadId;
  }

  async listBots(): Promise<{ id: string; name: string; title?: string; description?: string }[]> {
    return z.object({ bots: z.array(z.object({ id, name: z.string(), title: z.string().optional(), description: z.string().optional() })) })
      .parse(await this.request("GET", "/api/bots?messages=0")).bots;
  }

  forBot(botId: string): OpenMausBotChatRuntime {
    return new OpenMausBotChatRuntime({ url: this.origin, botId, token: this.token, publicUrl: this.publicUrl, downloadDirectory: this.downloadDirectory, fetch: this.fetcher });
  }

  async prepare(threadId: string) {
    return ownedSendSnapshotSchema.parse(await this.request("GET", `/api/bots/${this.botId}/messages/owned?threadId=${id.parse(threadId)}`));
  }

  async checkpoint(threadId: string, sendId: string) {
    const snapshot = await this.snapshot(threadId, sendId);
    if (!snapshot.messages[0]?.requestCancelled) throw new ChatRuntimeError("The paused request is no longer available");
    if (snapshot.activeTurnId !== null) throw new ChatRuntimeError("The paused execution is still stopping", true);
    const prepared = await this.prepare(threadId);
    if (prepared.activeLeafId !== snapshot.activeLeafId) throw new ChatRuntimeError("The paused execution is still settling", true);
    return prepared;
  }

  async upload(attachment: ChatAttachment, download: ChatDownloadedAttachment, uploadId: string): Promise<ChatStoredAttachment> {
    if (attachment.kind === "folder") throw new ChatRuntimeError("Folder must be expanded before upload", false, "folder");
    const image = attachment.kind === "image";
    let body: Readable | undefined;
    let sourceFailure: unknown;
    try {
      const filesPath = `/api/feishu/files${this.downloadDirectory ? `?directory=${encodeURIComponent(this.downloadDirectory)}` : ""}`;
      const limit = image ? 10 * 1024 * 1024 : z.object({ maxFileBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
        .parse(await this.request("GET", filesPath)).maxFileBytes;
      const prepared = await download.prepare?.(limit);
      const expectedBytes = prepared?.bytes ?? download.bytes;
      const mime = prepared?.mime ?? download.mime;
      if (expectedBytes !== undefined && expectedBytes > limit) throw new ChatRuntimeError("Attachment exceeds workspace limits", false, "size");
      body = Readable.from((async function* () {
        let bytes = 0;
        try {
          for await (const chunk of download.stream) {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += value.byteLength;
            if (bytes > limit) throw new ChatRuntimeError("Attachment exceeds workspace limits", false, "size");
            yield value;
          }
          if (expectedBytes !== undefined && bytes !== expectedBytes) throw new ChatRuntimeError("Attachment length changed", false, "integrity");
        } catch (error) { sourceFailure = error; throw error; }
      })());
      const url = new URL(filesPath, this.origin);
      url.searchParams.set("uploadId", uploadId);
      url.searchParams.set("name", attachment.name);
      url.searchParams.set("batchId", attachment.batchId ?? uploadId);
      url.searchParams.set("relativePath", attachment.sourcePath ?? attachment.name);
      if (image) url.searchParams.set("image", "1");
      const options: RequestInit & { duplex: "half" } = {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(image ? 120_000 : 30 * 60_000), duplex: "half", body: Readable.toWeb(body) as ReadableStream,
        headers: { authorization: `Bearer ${this.token}`, "content-type": mime, ...(expectedBytes === undefined ? {} : { "content-length": String(expectedBytes) }) },
      };
      const response = await this.fetcher(url.href, options);
      if (!response.ok) throw new ChatRuntimeError(`Attachment save failed (${response.status})`, response.status >= 500 && response.status !== 507,
        response.status === 507 ? "storage" : response.status === 413 ? "size" : "upload");
      const saved = z.object({ path: z.string().min(1), name: z.string().optional(), nativePath: z.string().optional(), bytes: z.number().int().nonnegative().safe().optional() }).parse(await response.json());
      return { kind: attachment.kind, path: saved.path, name: saved.name ?? attachment.name, ...(attachment.sourcePath ? { sourcePath: attachment.sourcePath } : {}), ...(saved.nativePath ? { nativePath: saved.nativePath } : {}), ...(saved.bytes === undefined ? {} : { bytes: saved.bytes }) };
    } catch (error) {
      if (sourceFailure instanceof ChatRuntimeError) throw sourceFailure;
      if (error instanceof ChatRuntimeError) throw error.attachmentFailure ? error : new ChatRuntimeError(error.message, error.retryable, error.retryable ? "network" : "upload");
      throw new ChatRuntimeError("Attachment transfer failed", false, "network");
    } finally { body?.destroy(); }
  }

  async createAttachmentDirectory(batchId: string, directories: string[]): Promise<string> {
    const query = this.downloadDirectory ? `?directory=${encodeURIComponent(this.downloadDirectory)}` : "";
    return z.object({ path: z.string().min(1) }).parse(await this.request("POST", `/api/feishu/directories${query}`, { batchId, directories })).path;
  }

  async send(threadId: string, sendId: string, text: string, leaf: string | null, approvalMode?: ApprovalMode, attachmentContext?: { directory?: string }): Promise<void> {
    await this.request("POST", `/api/bots/${this.botId}/messages/${approvalMode ? "owned" : "guarded"}`, {
      threadId, sendId, text, expectedActiveLeafId: leaf, expectedApprovalMode: approvalMode ?? "ask",
      ...(attachmentContext ? { attachmentContext } : {}),
    });
  }

  private snapshot(threadId: string, sendId: string) {
    return this.request("GET", `/api/bots/${this.botId}/requests/${id.parse(sendId)}?threadId=${id.parse(threadId)}`).then(value => snapshotSchema.parse(value));
  }

  async status(threadId: string, sendId: string) {
    const snapshot = await this.snapshot(threadId, sendId);
    if (snapshot.phase === "untracked") return { phase: snapshot.messages[0]?.requestCancelled ? "stopped" as const : "failed" as const };
    if (snapshot.phase !== "settled") {
      const latest = snapshot.messages.findLast(message => message.role === "bot" && (message.kind === "text" && message.text || message.kind === "activity" && message.tool));
      const activity = latest?.kind === "text" ? latest.text?.slice(-1000) : latest?.tool ? `${latest.tool.ok === undefined ? "正在执行" : latest.tool.ok ? "已完成" : "执行失败"}：${latest.tool.name.slice(0, 120)}` : undefined;
      return { phase: snapshot.phase, ...(activity ? { activity } : {}) };
    }
    const reply = snapshot.messages.findLast(message => message.role === "bot" && message.kind === "text" && message.turnTerminal && message.turnSucceeded);
    return reply ? { phase: "completed" as const, text: reply.text } : { phase: "failed" as const };
  }

  async stop(threadId: string, sendId: string): Promise<void> {
    const snapshot = await this.snapshot(threadId, sendId);
    if (snapshot.phase === "untracked") throw new ChatRuntimeError("The request no longer owns this execution");
    if (snapshot.phase === "settled") throw new ChatRuntimeError("The request already ended");
    await this.request("POST", `/api/bots/${this.botId}/requests/${id.parse(sendId)}/interrupt`, {
      threadId, messageId: snapshot.messageId, expectedActiveLeafId: snapshot.activeLeafId,
      expectedTurnId: snapshot.activeTurnId, expectedExecutionId: snapshot.executionId,
    });
  }

  conversationUrl(threadId: string): string | undefined {
    return this.publicUrl ? `${this.publicUrl}/?bot=${encodeURIComponent(this.botId)}&thread=${encodeURIComponent(threadId)}` : undefined;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new ChatRuntimeError("OpenMausBot could not be reached", true); }
    const result: unknown = await response.json();
    if (!response.ok) {
      const code = z.object({ code: z.string().optional() }).safeParse(result);
      const retryable = response.status >= 500 || response.status === 429 ||
        response.status === 409 && code.success && code.data.code === "guarded_busy";
      throw new ChatRuntimeError(`OpenMausBot refused the messaging request (${response.status})`, retryable);
    }
    return result;
  }
}
