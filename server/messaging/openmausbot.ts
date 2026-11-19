import { z } from "zod";
import { ChatRuntimeError, type ChatRuntime } from "./contracts.ts";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import { ownedSendSnapshotSchema } from "./owned-send.ts";

const id = z.string().regex(/^[\w-]+$/);
const snapshotSchema = z.object({
  messageId: id, activeLeafId: id.nullable(), activeTurnId: z.string().nullable(), executionId: id.nullable(),
  phase: z.enum(["working", "waiting", "settled", "untracked"]),
  messages: z.array(z.object({ role: z.string(), kind: z.string(), text: z.string().optional(), turnTerminal: z.boolean().optional(), turnSucceeded: z.boolean().optional(), requestCancelled: z.boolean().optional() })),
});

export class OpenMausBotChatRuntime implements ChatRuntime {
  readonly origin: string;
  private readonly botId: string;
  private readonly token: string;
  private readonly publicUrl?: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { url: string; botId: string; token: string; publicUrl?: string; fetch?: typeof fetch }) {
    const url = new URL(options.url);
    if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Messaging requires an explicit loopback OpenMausBot origin");
    this.origin = url.origin;
    this.botId = id.parse(options.botId);
    this.token = options.token;
    this.publicUrl = options.publicUrl;
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

  async prepare(threadId: string) {
    return ownedSendSnapshotSchema.parse(await this.request("GET", `/api/bots/${this.botId}/messages/owned?threadId=${id.parse(threadId)}`));
  }

  async send(threadId: string, sendId: string, text: string, leaf: string | null, approvalMode?: ApprovalMode): Promise<void> {
    await this.request("POST", `/api/bots/${this.botId}/messages/${approvalMode ? "owned" : "guarded"}`, {
      threadId, sendId, text, expectedActiveLeafId: leaf, expectedApprovalMode: approvalMode ?? "ask",
    });
  }

  private snapshot(threadId: string, sendId: string) {
    return this.request("GET", `/api/bots/${this.botId}/requests/${id.parse(sendId)}?threadId=${id.parse(threadId)}`).then(value => snapshotSchema.parse(value));
  }

  async status(threadId: string, sendId: string) {
    const snapshot = await this.snapshot(threadId, sendId);
    if (snapshot.phase === "untracked") return { phase: snapshot.messages[0]?.requestCancelled ? "stopped" as const : "failed" as const };
    if (snapshot.phase !== "settled") return { phase: snapshot.phase };
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
