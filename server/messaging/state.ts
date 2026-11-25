import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import { ATTACHMENT_FAILURES, MAX_EXPANDED_ATTACHMENTS, type ChatMessage } from "./contracts.ts";
import { APPROVAL_MODES } from "../../shared/approval-mode.ts";

const messageSchema = z.object({
  platform: z.string(), account: z.string(), id: z.string(), chatId: z.string(), senderId: z.string(),
  kind: z.enum(["direct", "group"]), threadId: z.string().optional(), text: z.string().max(12_000),
  replyToId: z.string().optional(),
  attachments: z.array(z.object({ kind: z.enum(["file", "image", "folder"]), key: z.string().regex(/^(?:file|img)_[\w-]{1,512}$/), name: z.string().min(1).max(512) }).strict()).max(4).optional(),
}).strict();
const jobSchema = z.object({
  id: z.string(), route: z.string(), message: messageSchema, at: z.number(),
  phase: z.enum(["queued", "submitting", "working", "waiting", "paused", "awaiting_description", "completed", "failed", "stopped"]),
  awaitingDescription: z.boolean().optional(),
  descriptionWaitAt: z.number().optional(),
  relatedMessageIds: z.array(z.string()).max(64).optional(),
  threadId: z.string().optional(), leaf: z.string().nullable().optional(),
  approvalMode: z.enum(APPROVAL_MODES).optional(),
  noticed: z.string().optional(), answer: z.string().optional(), deliveredParts: z.number().int().nonnegative().default(0),
  outboundParts: z.array(z.string()).optional(),
  retryAt: z.number().optional(), retries: z.number().int().nonnegative().optional(),
  stopTarget: z.string().optional(),
  expandedAttachments: z.array(z.object({ kind: z.enum(["file", "image"]), key: z.string().regex(/^(?:file|img)_[\w-]{1,512}$/), name: z.string().min(1).max(512), sourcePath: z.string().min(1).max(4096).optional(), bytes: z.number().int().nonnegative().safe().optional(), sizeChecked: z.literal(true).optional() }).strict()).max(MAX_EXPANDED_ATTACHMENTS).optional(),
  attachmentDirectories: z.array(z.string().min(1).max(4096)).max(1024).optional(),
  attachmentRoot: z.string().min(1).optional(),
  preparedAttachments: z.array(z.object({ kind: z.enum(["file", "image"]), path: z.string().min(1), name: z.string().min(1), sourcePath: z.string().min(1).max(4096).optional(), nativePath: z.string().min(1).optional(), bytes: z.number().int().nonnegative().safe().optional() }).strict()).max(MAX_EXPANDED_ATTACHMENTS).optional(),
  attachmentFailure: z.enum(ATTACHMENT_FAILURES).optional(),
  cardMessageId: z.string().optional(),
  cardUpdatedAt: z.number().optional(),
  cardSignature: z.string().optional(),
  cardRevision: z.number().int().nonnegative().optional(),
  control: z.enum(["pause", "resume", "stop"]).optional(),
  generation: z.number().int().nonnegative().optional(),
  pausedLeaf: z.string().nullable().optional(),
  pausedSendId: z.string().optional(),
  pausedAt: z.number().optional(),
  pausedMs: z.number().nonnegative().optional(),
  resume: z.boolean().optional(),
  activity: z.string().max(1000).optional(),
}).strict();
const stateSchema = z.object({ version: z.literal(1), scope: z.string(), routes: z.record(z.string(), z.string()), jobs: z.array(jobSchema) }).strict();
export type ChatJob = z.infer<typeof jobSchema>;
export const finished = (job: ChatJob) => ["completed", "failed", "stopped"].includes(job.phase);
export const delivered = (job: ChatJob) => finished(job) && job.noticed === job.phase;
export const chatHash = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export const chatUploadId = (parts: string[]) => {
  const digest = chatHash(parts);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
};
export const chatRoute = (message: ChatMessage) => chatHash([message.platform, message.account, message.kind, message.chatId,
  message.kind === "direct" ? message.senderId : message.threadId ?? message.id]);

export class ChatState {
  private readonly path: string;
  private readonly scope: string;
  private readonly now: () => number;
  readonly jobs: ChatJob[];
  readonly routes: Record<string, string>;

  constructor(path: string, scope: string, now: () => number = Date.now) {
    this.path = path;
    this.scope = scope;
    this.now = now;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read messaging state; refusing to discard request receipts"); }
    const parsed = stateSchema.safeParse(raw === undefined ? { version: 1, scope, routes: {}, jobs: [] } : raw);
    if (!parsed.success) throw new Error("Messaging state is invalid; refusing to discard request receipts");
    const state = parsed.data;
    if (state.scope !== scope) throw new Error("Messaging state belongs to another connection; choose a separate state file");
    this.jobs = state.jobs;
    this.routes = state.routes;
  }

  hasRoute(message: ChatMessage): boolean {
    const route = chatRoute(message);
    return Object.hasOwn(this.routes, route) || this.jobs.some(job => job.route === route);
  }

  enqueue(message: ChatMessage): "accepted" | "duplicate" | "full" {
    const id = chatHash([this.scope, message.platform, message.account, message.id]);
    if (this.jobs.some(job => job.id === id || job.message.platform === message.platform && job.message.account === message.account && job.relatedMessageIds?.includes(message.id))) return "duplicate";
    if (!message.attachments?.length && message.text.trim() && message.text !== "/stop") {
      const candidates = this.jobs.filter(job => job.awaitingDescription && !finished(job) &&
        !job.threadId && job.route === chatRoute(message) && job.message.senderId === message.senderId);
      const reply = message.replyToId && message.replyToId !== message.threadId;
      const target = message.replyToId && candidates.find(job => job.message.id === message.replyToId || job.cardMessageId === message.replyToId)
        || (!reply && candidates.length === 1 ? candidates[0] : undefined);
      if (target) {
        const before = { ...target, message: { ...target.message } };
        target.message = { ...target.message, text: message.text };
        target.relatedMessageIds = [...(target.relatedMessageIds ?? []), message.id];
        target.awaitingDescription = false;
        if (target.descriptionWaitAt !== undefined) {
          target.pausedMs = (target.pausedMs ?? 0) + this.now() - target.descriptionWaitAt;
          target.descriptionWaitAt = undefined;
        }
        if (target.phase === "awaiting_description") target.phase = "queued";
        target.retryAt = 0;
        try { this.save(); } catch (error) { Object.assign(target, before); throw error; }
        return "accepted";
      }
    }
    if (this.jobs.filter(job => !delivered(job)).length >= 500) return "full";
    const job: ChatJob = { id, route: chatRoute(message), message: { ...message }, at: this.now(), phase: "queued", deliveredParts: 0,
      ...(message.attachments?.length && !message.text.trim() ? { awaitingDescription: true } : {}) };
    if (!message.attachments?.length && message.text !== "/stop" && (!message.replyToId || message.replyToId === message.threadId) && this.jobs.filter(item => item.awaitingDescription && !finished(item) && item.route === job.route && item.message.senderId === message.senderId).length > 1) {
      job.phase = "completed"; job.answer = "有多个待处理附件，请引用要处理的附件，再发送具体要求。";
    }
    this.jobs.push(job);
    if (message.text === "/stop") {
      const added = this.jobs.at(-1)!;
      added.stopTarget = this.jobs.find(job => job !== added && job.route === added.route && !finished(job) &&
        job.message.text !== "/stop" && job.message.senderId === message.senderId)?.id;
    }
    try { this.save(); }
    catch (error) { this.jobs.splice(this.jobs.indexOf(job), 1); throw error; }
    return "accepted";
  }

  save(): void {
    const cutoff = this.now() - 7 * 24 * 3_600_000;
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      if (delivered(this.jobs[i]!) && this.jobs[i]!.at < cutoff) this.jobs.splice(i, 1);
    }
    while (this.jobs.length > 5_000) {
      const index = this.jobs.findIndex(delivered);
      if (index < 0) break;
      this.jobs.splice(index, 1);
    }
    const keep = new Set(this.jobs.map(job => job.route));
    for (const route of Object.keys(this.routes)) if (!keep.has(route)) delete this.routes[route];
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.path, JSON.stringify({ version: 1, scope: this.scope, routes: this.routes, jobs: this.jobs }), { mode: 0o600 });
  }
}
