import { attachmentFailureText, ChatRuntimeError, type ChatAttachment, type ChatDelivery, type ChatMessage, type ChatRuntime, type ChatTaskControl, type ChatTaskView } from "./contracts.ts";
import { Readable } from "node:stream";
import { ChatState, chatHash, chatUploadId, delivered, finished, type ChatJob } from "./state.ts";
import { escapeAttribute } from "../../src/lib/composer-attachments.ts";
import { DownloadRate } from "./download-rate.ts";

const paused = (job: ChatJob) => job.phase === "paused";
const totalBytes = (values: (number | undefined)[]): number | undefined => {
  let total = 0;
  for (const value of values) {
    if (value === undefined || !Number.isSafeInteger(value) || value < 0) return undefined;
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
};

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
  private readonly transfers = new Map<string, () => void>();
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

  control(input: ChatTaskControl): "accepted" | "refused" {
    const job = this.state.jobs.find(item => item.id === input.jobId);
    if (this.closed || !job || finished(job) || job.control || !this.allowed(job.message) ||
      job.phase === "awaiting_description" && input.action !== "stop" ||
      job.cardMessageId !== input.messageId || job.message.chatId !== input.chatId || job.message.senderId !== input.senderId ||
      (job.cardRevision ?? 0) !== input.revision || (input.action === "resume") !== (job.phase === "paused") && input.action !== "stop") return "refused";
    const previous = { control: job.control, cardRevision: job.cardRevision, retryAt: job.retryAt };
    job.control = input.action; job.cardRevision = (job.cardRevision ?? 0) + 1; job.retryAt = 0;
    try { this.state.save(); } catch (error) { Object.assign(job, previous); throw error; }
    this.transfers.get(job.id)?.();
    return "accepted";
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
      job.message.attachments = undefined;
      job.preparedAttachments = undefined;
      job.expandedAttachments = undefined;
      job.attachmentDirectories = undefined; job.attachmentRoot = undefined;
      job.control = undefined;
      job.activity = undefined;
      revoked = true;
    }
    if (revoked) this.state.save();
    if (this.delivery.present) await Promise.all(this.state.jobs.filter(job => job.phase === "queued" && !job.cardMessageId && this.allowed(job.message)).slice(0, 4).map(job => this.present(job)));
    const heads = new Map<string, ChatJob>();
    for (const job of this.state.jobs) if (!delivered(job) && (job.phase !== "awaiting_description" || job.control) && !heads.has(job.route)) heads.set(job.route, job);
    for (const job of this.state.jobs) if (!delivered(job) && job.message.text === "/stop" && heads.get(job.route)?.message.text !== "/stop") heads.set(job.route, job);
    for (const job of this.state.jobs) if (!delivered(job) && job.control && !heads.get(job.route)?.control) heads.set(job.route, job);
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
    for (const cancel of this.transfers.values()) cancel();
    while (this.running.size) await new Promise(resolve => setTimeout(resolve, 20));
  }

  private async advance(job: ChatJob): Promise<void> {
    await this.applyControl(job);
    if (paused(job)) { await this.present(job); return; }
    if (job.phase === "awaiting_description") { await this.present(job); return; }
    try {
      if (job.message.text === "/stop" && !finished(job)) await this.stopRequest(job);
      if (job.phase === "queued") {
        await this.present(job);
        await this.prepareAttachments(job);
        await this.applyControl(job);
        if (paused(job) || finished(job)) { await this.present(job); return; }
        if (job.awaitingDescription) {
          job.phase = "awaiting_description"; job.descriptionWaitAt = Date.now(); this.state.save();
          if (!await this.present(job) && job.noticed !== job.phase) await this.delivery.reply(job.message, "附件已保存，请发送处理要求。", `${job.id}:awaiting-description`);
          job.noticed = job.phase; this.state.save(); return;
        }
        const threadId = job.threadId ?? this.state.routes[job.route] ?? await this.runtime.createConversation(`${job.message.platform} ${job.message.kind === "group" ? "group" : "DM"}: ${job.message.text.slice(0, 40)}`);
        job.threadId = threadId;
        this.state.routes[job.route] = threadId;
        this.state.save();
        const prepared = job.resume && job.pausedSendId && this.runtime.checkpoint
          ? await this.runtime.checkpoint(threadId, job.pausedSendId) : await this.runtime.prepare(threadId);
        if (job.resume && !this.runtime.checkpoint && job.pausedLeaf !== undefined && job.pausedLeaf !== prepared.activeLeafId) throw new ChatRuntimeError("The paused conversation changed");
        job.leaf = prepared.activeLeafId;
        job.approvalMode = prepared.approvalMode;
        job.phase = "submitting";
        this.state.save();
      }
      if (job.phase === "submitting") {
        await this.send(job);
        job.phase = "working";
        this.state.save();
      }
      await this.applyControl(job);
      if (paused(job)) { await this.present(job); return; }
      if (!finished(job)) {
        const result = await this.runtime.status(job.threadId!, this.requestId(job));
        job.phase = result.phase;
        job.activity = result.activity;
        if (result.phase === "completed") job.answer = result.text ?? "任务已完成。";
        this.state.save();
      }
    } catch (error) {
      if (this.closed) throw new ChatRuntimeError("Connector is closing", true);
      if (job.control) { await this.applyControl(job); await this.present(job); return; }
      if (!(error instanceof ChatRuntimeError) || error.retryable) throw error;
      job.phase = "failed";
      job.attachmentFailure = error.attachmentFailure;
      this.state.save();
    }
    const presented = await this.present(job);
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
        : job.phase === "failed" ? job.attachmentFailure ? attachmentFailureText(job.attachmentFailure) : "任务未能完成，请在 OpenMausBot 中查看。"
        : job.phase === "stopped" ? "任务已停止。" : "已收到，正在处理。";
      const link = job.threadId ? this.runtime.conversationUrl(job.threadId) : undefined;
      if (!presented) await this.delivery.reply(job.message, `${text}${link ? `\n${link}` : ""}`, `${job.id}:${job.phase}`);
      job.noticed = job.phase;
      this.state.save();
    }
    job.retries = 0;
    job.retryAt = 0;
    if (delivered(job)) { job.answer = undefined; job.activity = undefined; job.outboundParts = undefined; job.message.text = ""; job.message.attachments = undefined; job.preparedAttachments = undefined; job.expandedAttachments = undefined; job.attachmentDirectories = undefined; job.attachmentRoot = undefined; }
    this.state.save();
  }

  private requestId(job: ChatJob): string { return job.generation ? chatHash([job.id, String(job.generation)]) : job.id; }

  private requestText(job: ChatJob): string {
    const attachments = job.preparedAttachments ?? [];
    const text = job.resume ? "继续完成此前暂停的请求。先检查已经完成的步骤和现有结果，避免重复执行；尚需审批的操作仍须审批。" : job.message.text;
    return [text, ...(job.resume ? [] : attachments).flatMap(attachment => [
      ...(attachment.nativePath ? [`<attached-image path="${escapeAttribute(attachment.nativePath)}" name="${escapeAttribute(attachment.name)}" />`] : []),
      `<attached-${attachment.nativePath ? "file" : attachment.kind} path="${escapeAttribute(attachment.path)}" name="${escapeAttribute(attachment.sourcePath ?? attachment.name)}" />`,
    ])].join("\n\n");
  }

  private send(job: ChatJob): Promise<void> {
    const context = job.preparedAttachments?.length || job.attachmentRoot ? job.attachmentRoot ? { directory: job.attachmentRoot } : {} : undefined;
    if (context) return this.runtime.send(job.threadId!, this.requestId(job), this.requestText(job), job.leaf ?? null, job.approvalMode, context);
    return this.runtime.send(job.threadId!, this.requestId(job), this.requestText(job), job.leaf ?? null, job.approvalMode);
  }

  private async applyControl(job: ChatJob): Promise<void> {
    try { await this.changeTask(job); }
    catch (error) {
      if (!(error instanceof ChatRuntimeError) || error.retryable) throw error;
      job.control = undefined; job.phase = "failed"; this.state.save();
    }
  }

  private async changeTask(job: ChatJob): Promise<void> {
    const action = job.control;
    if (!action) return;
    if (action === "resume") {
      if (job.pausedSendId) job.generation = (job.generation ?? 0) + 1;
      if (job.pausedAt !== undefined) job.pausedMs = (job.pausedMs ?? 0) + Date.now() - job.pausedAt;
      job.pausedAt = undefined;
      job.resume = Boolean(job.pausedSendId); job.phase = "queued"; job.activity = undefined;
    } else {
      if (["submitting", "working", "waiting"].includes(job.phase)) job.pausedSendId = this.requestId(job);
      if (job.phase === "submitting") await this.send(job);
      if (job.threadId && job.phase !== "queued" && job.phase !== "paused") {
        const status = await this.runtime.status(job.threadId, this.requestId(job));
        if (["completed", "failed"].includes(status.phase) || status.phase === "stopped" && action !== "pause") {
          job.phase = status.phase; job.answer = status.text; job.control = undefined; this.state.save(); return;
        }
        if (status.phase !== "stopped") await this.runtime.stop(job.threadId, this.requestId(job));
      }
      job.phase = action === "pause" ? "paused" : "stopped";
      if (job.phase === "paused") job.pausedAt = Date.now();
      if (job.phase === "paused" && job.threadId) job.pausedLeaf = (await this.runtime.prepare(job.threadId)).activeLeafId;
      job.activity = undefined;
    }
    job.control = undefined; this.state.save();
  }

  private async present(job: ChatJob, download?: ChatTaskView["download"], force = false): Promise<boolean> {
    if (this.closed || !this.delivery.present || job.message.text === "/stop") return false;
    const view: ChatTaskView = { id: job.id, revision: job.cardRevision ?? 0, phase: download ? "downloading" : job.phase,
      title: job.message.text || (job.message.attachments ?? []).map(attachment => attachment.name).join("、"), elapsedSeconds: Math.max(0, Math.floor(((job.pausedAt ?? job.descriptionWaitAt ?? Date.now()) - job.at - (job.pausedMs ?? 0)) / 10_000) * 10),
      detail: job.phase === "waiting" ? "需要在 OpenMausBot 中处理审批或补充信息。" : job.phase === "completed" ? "完整结果见下方回复。"
        : job.phase === "failed" ? job.attachmentFailure ? attachmentFailureText(job.attachmentFailure) : "任务未能完成，请在 OpenMausBot 中查看。" : job.phase === "awaiting_description" ? "附件已保存，请发送处理要求，或引用此附件说明要做什么。" : job.activity,
      ...(download ? { download } : {}), ...(job.threadId ? { url: this.runtime.conversationUrl(job.threadId) } : {}),
    };
    const signature = chatHash([JSON.stringify(view)]);
    if (signature === job.cardSignature || !force && download && Date.now() - (job.cardUpdatedAt ?? 0) < 2_000) return Boolean(job.cardMessageId);
    try {
      job.cardMessageId = await this.delivery.present(job.message, view, `${job.id}:card`, job.cardMessageId);
      job.cardSignature = signature; job.cardUpdatedAt = Date.now(); this.state.save();
      return true;
    } catch { this.log(`Task card ${job.id.slice(0, 12)} could not be updated`); return false; }
  }

  private async prepareAttachments(job: ChatJob): Promise<void> {
    if (job.message.attachments?.length && !job.expandedAttachments && (this.delivery.expand || job.message.attachments.some(attachment => attachment.kind === "folder"))) {
      if (!this.delivery.expand) throw new ChatRuntimeError("Folder expansion is unavailable", false, "folder");
      const controller = new AbortController();
      this.transfers.set(job.id, () => controller.abort());
      job.activity = job.message.attachments.some(attachment => attachment.kind === "folder") ? "正在读取文件夹目录…" : "正在获取附件大小…";
      try {
        await this.present(job);
        const expanded = await this.delivery.expand(job.message, controller.signal);
        job.expandedAttachments = expanded.attachments;
        job.attachmentDirectories = expanded.directories;
        if (job.control || this.closed) throw new ChatRuntimeError("Folder expansion interrupted");
        this.state.save();
      } finally { this.transfers.delete(job.id); job.activity = undefined; }
    }
    const attachments: ChatAttachment[] = job.expandedAttachments ?? job.message.attachments ?? [];
    const batchId = chatUploadId([job.id, "attachments"]);
    if ((attachments.length || job.attachmentDirectories?.length) && !job.attachmentRoot && this.runtime.createAttachmentDirectory) {
      job.attachmentRoot = await this.runtime.createAttachmentDirectory(batchId, job.attachmentDirectories ?? []);
      this.state.save();
    }
    if (!attachments.length) return;
    if (!this.delivery.download || !this.runtime.upload) throw new ChatRuntimeError("Attachment transport is unavailable", false, "download");
    job.preparedAttachments ??= [];
    const rate = new DownloadRate();
    let transferred = 0;
    for (let index = job.preparedAttachments.length; index < attachments.length; index++) {
      if (job.control || this.closed) throw new ChatRuntimeError("Attachment transfer interrupted");
      const attachment = attachments[index]!;
      const uploadId = chatUploadId([job.id, String(index), attachment.key]);
      const resource = await this.delivery.download(job.message, attachment);
      const cancel = resource.cancel ?? (() => resource.stream.destroy());
      this.transfers.set(job.id, cancel);
      let timer: ReturnType<typeof setInterval> | undefined;
      let reporting: Promise<void> | undefined;
      try {
        if (job.control || this.closed) throw new ChatRuntimeError("Attachment transfer interrupted");
        let received = 0;
        const report = async (force = false): Promise<void> => {
          if (reporting) { if (!force) return; await reporting; }
          const update = async () => {
            const progress = resource.progress?.() ?? { received, transferred: received };
            const total = progress.total ?? resource.bytes ?? attachment.bytes;
            const completed = totalBytes(attachments.slice(0, index).map((item, previous) => job.preparedAttachments?.[previous]?.bytes ?? item.bytes));
            const overallTotal = totalBytes(attachments.map((item, position) => position === index ? total : job.preparedAttachments?.[position]?.bytes ?? item.bytes));
            const overall = attachments.length > 1 && completed !== undefined ? { received: completed + progress.received, ...(overallTotal === undefined ? {} : { total: overallTotal }) } : undefined;
            const remaining = overall ? overall.total === undefined ? undefined : overall.total - overall.received : total === undefined ? undefined : total - progress.received;
            await this.present(job, { name: attachment.sourcePath ?? attachment.name, received: progress.received, ...(total === undefined ? {} : { total }),
              index: index + 1, count: attachments.length, ...(overall ? { overall } : {}), ...rate.measure(transferred + progress.transferred, remaining) }, force);
          };
          reporting = update();
          try { await reporting; } finally { reporting = undefined; }
        };
        await report(true);
        timer = setInterval(() => { if (!job.control && !this.closed) void report().catch(() => this.log(`Download progress ${job.id.slice(0, 12)} could not be updated`)); }, 1_000);
        timer.unref();
        const source = resource.stream;
        const stream = Readable.from((async function* () {
          for await (const chunk of source) {
            if (job.control) throw new ChatRuntimeError("Attachment transfer interrupted");
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += value.byteLength;
            await report();
            yield value;
          }
          if (job.control) throw new ChatRuntimeError("Attachment transfer interrupted");
        })());
        try {
          const saved = await this.runtime.upload({ ...attachment, batchId }, { ...resource, stream }, uploadId);
          job.preparedAttachments.push(saved);
          this.state.save();
          await report(true);
          transferred += resource.progress?.().transferred ?? received;
        } finally { stream.destroy(); }
      } finally { if (timer) clearInterval(timer); await reporting; this.transfers.delete(job.id); await cancel(); }
    }
  }

  private async stopRequest(control: ChatJob): Promise<void> {
    const target = this.state.jobs.find(job => job.id === control.stopTarget);
    control.answer = "没有找到你在这个会话中尚未结束的请求。";
    if (target && !finished(target)) {
      if (target.phase === "submitting") await this.send(target);
      if (target.threadId && target.phase !== "queued") {
        const status = await this.runtime.status(target.threadId, this.requestId(target));
        if (["completed", "failed", "stopped"].includes(status.phase)) {
          target.phase = status.phase;
          if (status.text) target.answer = status.text;
          control.answer = "这条请求已经结束，未停止其他任务。";
          control.phase = "completed";
          this.state.save();
          return;
        }
        if (target.phase !== "paused") await this.runtime.stop(target.threadId, this.requestId(target));
      }
      target.phase = "stopped";
      await this.present(target);
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
