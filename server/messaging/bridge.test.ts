import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { ChatBridge, replyParts } from "./bridge.ts";
import { ChatState, delivered } from "./state.ts";
import { ChatRuntimeError, type ChatMessage, type ChatRuntime } from "./contracts.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-chat-bridge-")); dirs.push(dir);
  const path = join(dir, "state.json");
  const runtime = {
    createConversation: vi.fn(async () => "thread-1"), prepare: vi.fn(async (): ReturnType<ChatRuntime["prepare"]> => ({ activeLeafId: null, approvalMode: "full" })),
    send: vi.fn(async () => {}), status: vi.fn(async (): ReturnType<ChatRuntime["status"]> => ({ phase: "working" })),
    stop: vi.fn(async () => {}), conversationUrl: () => "https://workspace.example.test/?thread=thread-1",
  } satisfies ChatRuntime;
  const replies: { text: string; id: string }[] = [];
  const delivery = { reply: vi.fn(async (_message: ChatMessage, text: string, id: string) => { replies.push({ text, id }); }) };
  const state = new ChatState(path, "fixture");
  const bridge = new ChatBridge({ runtime, delivery, state });
  return { path, state, runtime, delivery, replies, bridge };
}
const message: ChatMessage = { platform: "feishu", account: "app", id: "om_1", chatId: "oc_1", senderId: "ou_1", kind: "direct", text: "hello" };

describe("durable messaging bridge", () => {
  it("deduplicates delivery across restart and reuses a DM conversation", async () => {
    const fx = fixture();
    expect(fx.bridge.accept(message)).toBe("accepted");
    expect(fx.bridge.accept(message)).toBe("duplicate");
    await fx.bridge.tick();
    const state = new ChatState(fx.path, "fixture");
    const bridge = new ChatBridge({ ...fx, state });
    expect(bridge.accept(message)).toBe("duplicate");
    await bridge.tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
    expect(fx.replies).toHaveLength(1);
    fx.runtime.status.mockResolvedValue({ phase: "completed", text: "done" });
    await bridge.tick();
    bridge.accept({ ...message, id: "om_2" });
    await bridge.tick();
    expect(fx.runtime.createConversation).toHaveBeenCalledTimes(1);
    expect(fx.runtime.send).toHaveBeenCalledTimes(2);
    expect(fx.replies.filter(reply => reply.text === "done")).toHaveLength(2);
  });
  it("does not acknowledge or deduplicate a message whose durable save failed", () => {
    const fx = fixture();
    vi.spyOn(fx.state, "save").mockImplementationOnce(() => { throw new Error("disk unavailable"); });
    expect(() => fx.bridge.accept(message)).toThrow("disk unavailable");
    expect(fx.state.jobs).toHaveLength(0);
    expect(fx.bridge.accept(message)).toBe("accepted");
    expect(new ChatState(fx.path, "fixture").jobs).toHaveLength(1);
    expect(message.text).toBe("hello");
  });
  it("holds later messages while a request waits for human input", async () => {
    const fx = fixture();
    fx.runtime.status.mockResolvedValue({ phase: "waiting" });
    fx.bridge.accept(message); fx.bridge.accept({ ...message, id: "om_2" });
    await fx.bridge.tick(); await fx.bridge.tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
    expect(fx.replies).toHaveLength(1);
    expect(fx.replies[0]!.text).toContain("OpenMausBot");
    fx.runtime.status.mockResolvedValue({ phase: "completed", text: "approved result" });
    await fx.bridge.tick(); await fx.bridge.tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(2);
  });
  it("persists the exact send preconditions before an uncertain send, then retries the same receipt", async () => {
    const fx = fixture();
    fx.runtime.prepare.mockResolvedValue({ activeLeafId: "leaf-original", approvalMode: "ask" });
    fx.runtime.send.mockRejectedValueOnce(new ChatRuntimeError("lost acknowledgement", true));
    fx.bridge.accept(message); await fx.bridge.tick();
    const persisted = new ChatState(fx.path, "fixture");
    expect(persisted.jobs[0]).toMatchObject({ phase: "submitting", leaf: "leaf-original", approvalMode: "ask" });
    persisted.jobs[0]!.retryAt = 0;
    const restarted = new ChatBridge({ ...fx, state: persisted });
    await restarted.tick();
    expect(fx.runtime.send.mock.calls[0]).toEqual(fx.runtime.send.mock.calls[1]);
    expect(fx.runtime.prepare).toHaveBeenCalledTimes(1);
  });
  it("keeps a completed answer across restart and retries delivery without rerunning the model", async () => {
    const fx = fixture();
    fx.runtime.status.mockResolvedValue({ phase: "completed", text: "💡".repeat(2_050) });
    fx.delivery.reply.mockRejectedValueOnce(new Error("lost platform response"));
    fx.bridge.accept(message); await fx.bridge.tick();
    const state = new ChatState(fx.path, "fixture"); state.jobs[0]!.retryAt = 0;
    await new ChatBridge({ ...fx, state }).tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
    expect(fx.delivery.reply.mock.calls[0]![2]).toBe(fx.delivery.reply.mock.calls[1]![2]);
    expect(fx.replies.map(reply => reply.text).join("")).toBe("💡".repeat(2_050));
    expect(delivered(state.jobs[0]!)).toBe(true);
    expect(state.jobs[0]!.answer).toBeUndefined();
    expect(state.jobs[0]!.outboundParts).toBeUndefined();
    expect(state.jobs[0]!.message.text).toBe("");
  });
  it("does not retry a rejected branch or forward an unrelated answer", async () => {
    const fx = fixture();
    fx.runtime.send.mockRejectedValue(new ChatRuntimeError("changed branch"));
    fx.bridge.accept(message); await fx.bridge.tick(); await fx.bridge.tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
    expect(fx.runtime.status).not.toHaveBeenCalled();
    expect(fx.replies[0]!.text).toContain("未能完成");
  });
  it("persists platform formatting before sending and resumes the same parts after a formatter changes", async () => {
    const fx = fixture();
    fx.runtime.status.mockResolvedValue({ phase: "completed", text: "original report" });
    const formatReply = vi.fn(() => ["header\nrow one", "header\nrow two"]);
    fx.delivery.reply.mockImplementationOnce(async (_message, text, id) => { fx.replies.push({ text, id }); })
      .mockRejectedValueOnce(new Error("lost platform reply"));
    const bridge = new ChatBridge({ ...fx, delivery: { ...fx.delivery, formatReply } });
    bridge.accept(message); await bridge.tick();
    const state = new ChatState(fx.path, "fixture");
    expect(state.jobs[0]).toMatchObject({ deliveredParts: 1, outboundParts: ["header\nrow one", "header\nrow two"] });
    state.jobs[0]!.retryAt = 0;
    const changedFormat = vi.fn(() => ["different report layout"]);
    await new ChatBridge({ ...fx, state, delivery: { ...fx.delivery, formatReply: changedFormat } }).tick();
    expect(changedFormat).not.toHaveBeenCalled();
    expect(fx.delivery.reply.mock.calls[1]!.slice(1)).toEqual(fx.delivery.reply.mock.calls[2]!.slice(1));
    expect(fx.replies.map(reply => reply.text)).toEqual(["header\nrow one", "header\nrow two"]);
    expect(state.jobs[0]!.outboundParts).toBeUndefined();
  });
  it("keeps a partially sent legacy answer's original boundaries instead of sending a new layout's tail", async () => {
    const fx = fixture(); fx.bridge.accept(message);
    const job = fx.state.jobs[0]!;
    job.phase = "completed"; job.answer = "x".repeat(2_050); job.deliveredParts = 1;
    fx.state.save();
    const formatReply = vi.fn(() => ["whole new layout"]);
    await new ChatBridge({ ...fx, delivery: { ...fx.delivery, formatReply } }).tick();
    expect(formatReply).not.toHaveBeenCalled();
    expect(fx.replies.map(reply => reply.text.length)).toEqual([1_000, 50]);
    expect(fx.delivery.reply.mock.calls[0]![2]).toBe(`${job.id}:answer:1`);
  });
  it("persists a stop target, interrupts only its sender's request and does not send /stop to the model", async () => {
    const fx = fixture(); fx.bridge.accept(message); await fx.bridge.tick();
    fx.bridge.accept({ ...message, id: "om_stop", text: "/stop" });
    await fx.bridge.tick();
    expect(fx.runtime.stop).toHaveBeenCalledWith("thread-1", fx.state.jobs[0]!.id);
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
    expect(fx.state.jobs[0]!.phase).toBe("stopped");
    expect(fx.replies.at(-1)!.text).toContain("已停止");
    fx.bridge.accept({ ...message, senderId: "ou_other", id: "om_other_stop", text: "/stop" });
    await fx.bridge.tick();
    expect(fx.runtime.stop).toHaveBeenCalledTimes(1);
  });
  it("rejects another connection's state and never silently resets corrupt receipts", async () => {
    const fx = fixture(); fx.bridge.accept(message);
    expect(() => new ChatState(fx.path, "other")).toThrow(/another connection/);
    if (process.platform !== "win32") expect(statSync(fx.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(fx.path, "utf8")).not.toContain("Bearer");
    writeFileSync(fx.path, "broken JSON");
    expect(() => new ChatState(fx.path, "fixture")).toThrow(/refusing/);
  });
  it("bounds concurrency and refuses new messages after shutdown", async () => {
    const fx = fixture();
    for (let i = 0; i < 8; i++) fx.bridge.accept({ ...message, id: `om_${i}`, chatId: `oc_${i}` });
    await fx.bridge.tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(4);
    await fx.bridge.tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(8);
    await fx.bridge.close();
    expect(fx.bridge.accept({ ...message, id: "om_closed" })).toBe("closed");
    expect(replyParts("🦊".repeat(1_001)).map(part => Array.from(part).length)).toEqual([1_000, 1]);
  });
  it("rechecks authorization for a persisted queue before resuming or replying", async () => {
    const fx = fixture(); fx.bridge.accept(message);
    const state = new ChatState(fx.path, "fixture");
    const bridge = new ChatBridge({ ...fx, state, allowed: () => false });
    await bridge.tick();
    expect(fx.runtime.createConversation).not.toHaveBeenCalled();
    expect(fx.runtime.send).not.toHaveBeenCalled();
    expect(fx.delivery.reply).not.toHaveBeenCalled();
    expect(delivered(state.jobs[0]!)).toBe(true);
  });
  it("does not let another group participant stop someone else's request", async () => {
    const fx = fixture();
    const group = { ...message, kind: "group" as const, threadId: "om_topic" };
    fx.bridge.accept(group); await fx.bridge.tick();
    fx.bridge.accept({ ...group, id: "om_stop_other", senderId: "ou_other", text: "/stop" });
    await fx.bridge.tick();
    expect(fx.runtime.stop).not.toHaveBeenCalled();
    expect(fx.state.jobs[0]!.phase).toBe("working");
    expect(fx.replies.at(-1)!.text).toContain("没有找到");
  });
  it("cancels a queued request before it starts and cannot stop a later request with an old command", async () => {
    const fx = fixture();
    fx.bridge.accept(message);
    fx.bridge.accept({ ...message, id: "om_stop", text: "/stop" });
    await fx.bridge.tick();
    expect(fx.runtime.send).not.toHaveBeenCalled();
    expect(fx.state.jobs[0]!.phase).toBe("stopped");
    fx.bridge.accept({ ...message, id: "om_later" });
    await fx.bridge.tick();
    expect(fx.bridge.accept({ ...message, id: "om_stop", text: "/stop" })).toBe("duplicate");
    await fx.bridge.tick();
    expect(fx.runtime.stop).not.toHaveBeenCalled();
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
  });
});
