import { z } from "zod";
import type { ChatTaskControl, ChatTaskView } from "../messaging/contracts.ts";

const labels: Record<ChatTaskView["phase"], string> = {
  queued: "等待处理", downloading: "正在下载附件", submitting: "正在提交任务", working: "正在处理",
  waiting: "等待你处理", paused: "已暂停", awaiting_description: "等待处理要求", completed: "已完成", failed: "处理失败", stopped: "已结束",
};
const plain = (content: string) => ({ tag: "plain_text", content });
const escaped = (text: string) => text.replace(/[&<>*~[\]()#_`]/g, char => `&#${char.charCodeAt(0)};`);
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const speed = (bytes: number | undefined) => bytes === undefined ? "测速中" : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB/s`
  : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB/s` : `${Math.round(bytes)} B/s`;
const remainingTime = (seconds: number) => seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;

export function feishuTaskCard(view: ChatTaskView) {
  const terminal = ["completed", "failed", "stopped"].includes(view.phase);
  const color = view.phase === "failed" ? "red" : view.phase === "completed" ? "green" : view.phase === "waiting" || view.phase === "paused" ? "orange" : "blue";
  const elements: Record<string, unknown>[] = [{ tag: "column_set", flex_mode: "none", columns: [{
    tag: "column", width: "weighted", weight: 1, background_style: "grey-50", padding: "12px", vertical_spacing: "4px", elements: [
      { tag: "markdown", content: `**${escaped(view.title.slice(0, 120))}**` },
      { tag: "markdown", text_size: "notation", content: `已用时 ${Math.floor(view.elapsedSeconds / 60)} 分 ${view.elapsedSeconds % 60} 秒` },
    ],
  }] }];
  if (view.download) {
    const file = view.download;
    elements.push({ tag: "markdown", content: `${escaped(file.name)} · 附件 ${file.index}/${file.count}\n${megabytes(file.received)}${file.total === undefined ? " · 总大小未知" : ` / ${megabytes(file.total)}`}\n当前速率 ${speed(file.bytesPerSecond)}${file.etaSeconds === undefined ? "" : ` · 预计${file.overall ? "整体" : ""}剩余 ${remainingTime(file.etaSeconds)}`}` });
    if (file.overall) elements.push({ tag: "markdown", content: `整体进度 ${megabytes(file.overall.received)}${file.overall.total === undefined ? " · 总大小未知" : ` / ${megabytes(file.overall.total)}`}` });
    const progress = file.overall?.total === undefined ? file : file.overall;
    if (progress.total && progress.total > 0) elements.push({ tag: "chart", height: "80px", preview: false, chart_spec: {
      type: "linearProgress", direction: "horizontal", data: { values: [{ type: file.overall?.total === undefined ? "当前文件进度" : "整体进度", value: Math.min(1, progress.received / progress.total) }] },
      xField: "value", yField: "type", seriesField: "type", axes: [{ orient: "bottom", min: 0, max: 1, visible: false }],
    } });
  }
  if (view.detail) elements.push({ tag: "markdown", content: escaped(view.detail.slice(0, 1000)) });
  const button = (action: "pause" | "resume" | "stop", content: string) => ({
    tag: "button", text: plain(content), type: action === "stop" ? "danger" : "primary_filled",
    behaviors: [{ type: "callback", value: { jobId: view.id, action, revision: view.revision } }],
  });
  const buttons: Record<string, unknown>[] = [];
  if (!terminal) {
    if (view.phase !== "awaiting_description") buttons.push(button(view.phase === "paused" ? "resume" : "pause", view.phase === "paused" ? "继续" : "暂停"));
    buttons.push(button("stop", "结束任务"));
  }
  if (view.url) buttons.push({ tag: "button", text: plain("查看会话"), type: "default", behaviors: [{ type: "open_url", default_url: view.url }] });
  if (buttons.length) elements.push({ tag: "column_set", flex_mode: "none", columns: buttons.map(value => ({ tag: "column", width: "weighted", weight: 1, elements: [value] })) });
  if (!terminal) elements.push({ tag: "markdown", text_size: "notation", content: "仅任务发起人可操作。暂停会中断当前处理，继续时从已有会话接续。" });
  return { schema: "2.0", config: { update_multi: true, width_mode: "default", enable_forward: false },
    header: { title: plain(labels[view.phase]), template: color }, body: { vertical_spacing: "12px", elements } };
}

const callbackSchema = z.object({
  operator: z.object({ open_id: z.string().regex(/^ou_[\w-]+$/) }),
  context: z.object({ open_message_id: z.string().regex(/^om_[\w-]+$/), open_chat_id: z.string().regex(/^oc_[\w-]+$/) }),
  action: z.object({ tag: z.literal("button"), value: z.object({ jobId: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(["pause", "resume", "stop"]), revision: z.number().int().nonnegative() }).strict() }),
});

export function feishuTaskControl(raw: unknown): ChatTaskControl | null {
  const parsed = callbackSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { operator, context, action } = parsed.data;
  return { ...action.value, senderId: operator.open_id, chatId: context.open_chat_id, messageId: context.open_message_id };
}
