import { ChatRuntimeError, type ChatDelivery, type ChatMessage, type ChatRuntime } from "./contracts.ts";
import { ChatState, delivered, finished, type ChatJob } from "./state.ts";

export function replyParts(text: string): string[] {
  const chars = Array.from(text);
  const parts: string[] = [];
  for (let i = 0; i < chars.length; i += 1_000) parts.push(chars.slice(i, i + 1_000).join(""));
  return parts.length ? parts : ["任务已完成。"];
}

export class ChatBridge {
  private readonly runtime: ChatRuntime;
  private readonly delivery: ChatDelivery;
  private readonly state: ChatState;
  private readonly log: (message: string) => void;
  private readonly allowed: (message: ChatMessage) => boolean;
  private readonly running = new Set<string>();
  private closed = false;
  private cursor = 0;

  constructor(deps: { runtime: ChatRuntime; delivery: ChatDelivery; state: ChatState; log?: (message: string) => void; allowed?: (message: ChatMessage) => boolean }) {
    this.runtime = deps.runtime;
    this.delivery = deps.delivery;
    this.state = deps.state;
    this.log = deps.log ?? (() => {});
    this.allowed = deps.allowed ?? (() => true);
  }

  accept(message: ChatMessage) {
    if (this.closed) return "closed" as const;
    return this.state.enqueue(message);
  }

  async tick(): Promise<void> {
    if (this.closed) return;
    let revoked = false;
    for (const job of this.state.jobs) if (!delivered(job) && !this.allowed(job.message)) {
      job.phase = "failed";
      job.noticed = "failed";
      job.answer = undefined;
      job.outboundParts = undefined;
      job.message.text = "";
      revoked = true;
    }
    if (revoked) this.state.save();
    const heads = new Map<string, ChatJob>();
    for (const job of this.state.jobs) if (!delivered(job) && !heads.has(job.route)) heads.set(job.route, job);
    for (const job of this.state.jobs) if (!delivered(job) && job.message.text === "/stop" && heads.get(job.route)?.message.text !== "/stop") heads.set(job.route, job);
    const ready = [...heads.values()].filter(job => !this.running.has(job.route) && (job.retryAt ?? 0) <= Date.now());
    const start = this.cursor % Math.max(1, ready.length);
    const next = [...ready.slice(start), ...ready.slice(0, start)].slice(0, Math.max(0, 4 - this.running.size));
    this.cursor = start + next.length;
    await Promise.all(next.map(async job => {
      this.running.add(job.route);
      try { await this.advance(job); }
      catch {
        job.retries = (job.retries ?? 0) + 1;
        job.retryAt = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(job.retries, 6));
        this.state.save();
        this.log(`Message ${job.id.slice(0, 12)} will retry`);
      }
      finally { this.running.delete(job.route); }
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.running.size) await new Promise(resolve => setTimeout(resolve, 20));
  }

  private async advance(job: ChatJob): Promise<void> {
    try {
      if (job.message.text === "/stop" && !finished(job)) await this.stopRequest(job);
      if (job.phase === "queued") {
        const threadId = job.threadId ?? this.state.routes[job.route] ?? await this.runtime.createConversation(`${job.message.platform} ${job.message.kind === "group" ? "group" : "DM"}: ${job.message.text.slice(0, 40)}`);
        job.threadId = threadId;
        this.state.routes[job.route] = threadId;
        this.state.save();
        const prepared = await this.runtime.prepare(threadId);
        job.leaf = prepared.activeLeafId;
        job.approvalMode = prepared.approvalMode;
        job.phase = "submitting";
        this.state.save();
      }
      if (job.phase === "submitting") {
        await this.runtime.send(job.threadId!, job.id, job.message.text, job.leaf ?? null, job.approvalMode);
        job.phase = "working";
        this.state.save();
      }
      if (!finished(job)) {
        const result = await this.runtime.status(job.threadId!, job.id);
        job.phase = result.phase;
        if (result.phase === "completed") job.answer = result.text ?? "任务已完成。";
        this.state.save();
      }
    } catch (error) {
      if (!(error instanceof ChatRuntimeError) || error.retryable) throw error;
      job.phase = "failed";
      this.state.save();
    }
    if (job.phase === "completed") {
      if (!job.outboundParts) {
        const answer = job.answer ?? "任务已完成。";
        job.outboundParts = job.deliveredParts > 0 ? replyParts(answer) : this.delivery.formatReply?.(answer) ?? replyParts(answer);
        this.state.save();
      }
      const parts = job.outboundParts;
      while (job.deliveredParts < parts.length) {
        await this.delivery.reply(job.message, parts[job.deliveredParts]!, `${job.id}:answer:${job.deliveredParts}`);
        job.deliveredParts++;
        this.state.save();
      }
      job.noticed = job.phase;
      this.state.save();
    } else if (job.noticed !== job.phase) {
      const text = job.phase === "waiting" ? "需要你在 OpenMausBot 中处理审批或补充信息。"
        : job.phase === "failed" ? "任务未能完成，请在 OpenMausBot 中查看。"
        : job.phase === "stopped" ? "任务已停止。" : "已收到，正在处理。";
      const link = job.threadId ? this.runtime.conversationUrl(job.threadId) : undefined;
      await this.delivery.reply(job.message, `${text}${link ? `\n${link}` : ""}`, `${job.id}:${job.phase}`);
      job.noticed = job.phase;
      this.state.save();
    }
    job.retries = 0;
    job.retryAt = 0;
    if (delivered(job)) { job.answer = undefined; job.outboundParts = undefined; job.message.text = ""; }
    this.state.save();
  }

  private async stopRequest(control: ChatJob): Promise<void> {
    const target = this.state.jobs.find(job => job.id === control.stopTarget);
    control.answer = "没有找到你在这个会话中尚未结束的请求。";
    if (target && !finished(target)) {
      if (target.phase === "submitting") await this.runtime.send(target.threadId!, target.id, target.message.text, target.leaf ?? null, target.approvalMode);
      if (target.threadId && target.phase !== "queued") {
        const status = await this.runtime.status(target.threadId, target.id);
        if (["completed", "failed", "stopped"].includes(status.phase)) {
          target.phase = status.phase;
          if (status.text) target.answer = status.text;
          control.answer = "这条请求已经结束，未停止其他任务。";
          control.phase = "completed";
          this.state.save();
          return;
        }
        await this.runtime.stop(target.threadId, target.id);
      }
      target.phase = "stopped";
      target.noticed = "stopped";
      target.answer = undefined;
      target.outboundParts = undefined;
      target.message.text = "";
      control.answer = "已停止这条请求。";
    }
    control.phase = "completed";
    this.state.save();
  }
}
