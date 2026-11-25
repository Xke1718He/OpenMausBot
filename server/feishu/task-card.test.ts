import { expect, it } from "vitest";
import { feishuTaskCard, feishuTaskControl } from "./task-card.ts";
import type { ChatTaskView } from "../messaging/contracts.ts";

const view: ChatTaskView = { id: "a".repeat(64), revision: 2, phase: "working", title: "Summarize the report", elapsedSeconds: 32, detail: "Reading the report" };
const buttons = (card: ReturnType<typeof feishuTaskCard>) => card.body.elements.flatMap(element =>
  (element.columns as { elements: { tag: string; behaviors?: { type: string; value?: unknown }[] }[] }[] | undefined)?.flatMap(column => column.elements.filter(element => element.tag === "button")) ?? []);

it("uses shared Card 2.0 with controls bound to a task and revision, and removes controls when finished", () => {
  const card = feishuTaskCard(view);
  expect(card).toMatchObject({ schema: "2.0", config: { update_multi: true, enable_forward: false }, header: { title: { content: "正在处理" } } });
  expect(buttons(card).map(button => button.behaviors?.[0]?.value)).toEqual([
    { jobId: view.id, revision: 2, action: "pause" }, { jobId: view.id, revision: 2, action: "stop" },
  ]);
  expect(buttons(feishuTaskCard({ ...view, phase: "paused" }))[0]!.behaviors?.[0]?.value).toMatchObject({ action: "resume" });
  expect(buttons(feishuTaskCard({ ...view, phase: "completed" }))).toHaveLength(0);
  const awaiting = feishuTaskCard({ ...view, phase: "awaiting_description" });
  expect(awaiting.header.title.content).toBe("等待处理要求");
  expect(buttons(awaiting).map(button => button.behaviors?.[0]?.value)).toEqual([{ jobId: view.id, revision: 2, action: "stop" }]);
});

it("renders measured download progress as a chart and omits percentages when total size is unknown", () => {
  const download = { name: "<at id=all> & report.zip", received: 32, total: 100, index: 1, count: 2 };
  const card = feishuTaskCard({ ...view, phase: "downloading", download });
  const chart = card.body.elements.find(element => element.tag === "chart");
  expect(chart).toMatchObject({ chart_spec: { type: "linearProgress", data: { values: [{ value: 0.32 }] } } });
  expect(JSON.stringify(card)).not.toContain("<at id=all>");
  expect(feishuTaskCard({ ...view, download: { ...download, total: undefined } }).body.elements.some(element => element.tag === "chart")).toBe(false);
});

it("uses aggregate bytes for a folder's chart rather than the current file's completed percentage", () => {
  const card = feishuTaskCard({ ...view, phase: "downloading", download: { name: "bag/one.mcap", received: 100, total: 100, index: 1, count: 2,
    overall: { received: 100, total: 400 }, bytesPerSecond: 50, etaSeconds: 6 } });
  expect(card.body.elements.find(element => element.tag === "chart")).toMatchObject({ chart_spec: { data: { values: [{ type: "整体进度", value: 0.25 }] } } });
  expect(JSON.stringify(card)).toContain("预计整体剩余 6 秒");
});

it("accepts documented callback context and refuses malformed controls", () => {
  const raw = { operator: { open_id: "ou_owner" }, context: { open_message_id: "om_card", open_chat_id: "oc_group" },
    action: { tag: "button", value: { jobId: view.id, action: "pause", revision: 2 } } };
  expect(feishuTaskControl(raw)).toEqual({ jobId: view.id, action: "pause", revision: 2, senderId: "ou_owner", messageId: "om_card", chatId: "oc_group" });
  expect(feishuTaskControl({ ...raw, operator: { user_id: "owner" } })).toBeNull();
  expect(feishuTaskControl({ ...raw, action: { ...raw.action, value: { ...raw.action.value, revision: -1 } } })).toBeNull();
});

it("formats download speed and remaining time without showing stale metrics on paused cards", () => {
  const download = { name: "file.zip", received: 1024, total: 100000, index: 1, count: 1, bytesPerSecond: 2.5 * 1024 * 1024, etaSeconds: 65 };
  expect(JSON.stringify(feishuTaskCard({ ...view, phase: "downloading", download }))).toContain("当前速率 2.50 MB/s · 预计剩余 1 分 5 秒");
  expect(JSON.stringify(feishuTaskCard({ ...view, download: { ...download, total: undefined, bytesPerSecond: 5120, etaSeconds: undefined } }))).toContain("当前速率 5.0 KB/s");
  expect(JSON.stringify(feishuTaskCard({ ...view, download: { ...download, bytesPerSecond: 0, etaSeconds: undefined } }))).toContain("当前速率 0 B/s");
  expect(JSON.stringify(feishuTaskCard({ ...view, phase: "paused" }))).not.toContain("当前速率");
});
