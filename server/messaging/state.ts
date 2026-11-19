import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import type { ChatMessage } from "./contracts.ts";
import { APPROVAL_MODES } from "../../shared/approval-mode.ts";

const messageSchema = z.object({
  platform: z.string(), account: z.string(), id: z.string(), chatId: z.string(), senderId: z.string(),
  kind: z.enum(["direct", "group"]), threadId: z.string().optional(), text: z.string().max(12_000),
}).strict();
const jobSchema = z.object({
  id: z.string(), route: z.string(), message: messageSchema, at: z.number(),
  phase: z.enum(["queued", "submitting", "working", "waiting", "completed", "failed", "stopped"]),
  threadId: z.string().optional(), leaf: z.string().nullable().optional(),
  approvalMode: z.enum(APPROVAL_MODES).optional(),
  noticed: z.string().optional(), answer: z.string().optional(), deliveredParts: z.number().int().nonnegative().default(0),
  outboundParts: z.array(z.string()).optional(),
  retryAt: z.number().optional(), retries: z.number().int().nonnegative().optional(),
  stopTarget: z.string().optional(),
}).strict();
const stateSchema = z.object({ version: z.literal(1), scope: z.string(), routes: z.record(z.string(), z.string()), jobs: z.array(jobSchema) }).strict();
export type ChatJob = z.infer<typeof jobSchema>;
export const finished = (job: ChatJob) => ["completed", "failed", "stopped"].includes(job.phase);
export const delivered = (job: ChatJob) => finished(job) && job.noticed === job.phase;
export const chatHash = (parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
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

  enqueue(message: ChatMessage): "accepted" | "duplicate" | "full" {
    const id = chatHash([this.scope, message.platform, message.account, message.id]);
    if (this.jobs.some(job => job.id === id)) return "duplicate";
    if (this.jobs.filter(job => !delivered(job)).length >= 500) return "full";
    const job: ChatJob = { id, route: chatRoute(message), message: { ...message }, at: this.now(), phase: "queued", deliveredParts: 0 };
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
