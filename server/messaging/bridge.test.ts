import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { ChatBridge, replyParts } from "./bridge.ts";
import { ChatState, delivered } from "./state.ts";
import { ChatRuntimeError, type ChatMessage, type ChatRuntime, type ChatTaskView, type ChatDelivery } from "./contracts.ts";
import { Readable } from "node:stream";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-chat-bridge-")); dirs.push(dir);
  const path = join(dir, "state.json");
  const runtime = {
    createConversation: vi.fn(async () => "thread-1"), prepare: vi.fn(async (): ReturnType<ChatRuntime["prepare"]> => ({ activeLeafId: null, approvalMode: "full" })),
    send: vi.fn<ChatRuntime["send"]>(async () => {}), status: vi.fn(async (): ReturnType<ChatRuntime["status"]> => ({ phase: "working" })),
    stop: vi.fn<ChatRuntime["stop"]>(async () => {}), conversationUrl: () => "https://workspace.example.test/?thread=thread-1",
  } satisfies ChatRuntime;
  const replies: { text: string; id: string }[] = [];
  const delivery = { reply: vi.fn(async (_message: ChatMessage, text: string, id: string) => { replies.push({ text, id }); }) };
  const state = new ChatState(path, "fixture");
  const bridge = new ChatBridge({ runtime, delivery, state });
  return { path, state, runtime, delivery, replies, bridge };
}
const message: ChatMessage = { platform: "feishu", account: "app", id: "om_1", chatId: "oc_1", senderId: "ou_1", kind: "direct", text: "hello" };

function cardFixture() {
  const fx = fixture();
  const views: ChatTaskView[] = [];
  const present = vi.fn<NonNullable<ChatDelivery["present"]>>(async (_message, view) => { views.push(view); return "om_card"; });
  const delivery = { ...fx.delivery, present };
  const bridge = new ChatBridge({ ...fx, delivery });
  const input = (action: "pause" | "resume" | "stop", revision = 0) => ({ jobId: fx.state.jobs[0]!.id, action, revision, senderId: message.senderId, chatId: message.chatId, messageId: "om_card" });
  return { ...fx, bridge, delivery, views, input };
}

describe("task cards and controls", () => {
  it("reports cumulative folder bytes after pause/restart without counting saved receipts twice", async () => {
    const fx = cardFixture();
    const files = [{ kind: "file" as const, key: "file_one", name: "one", sourcePath: "bag/one", bytes: 4 }, { kind: "file" as const, key: "file_two", name: "two", sourcePath: "bag/two", bytes: 6 }];
    const expand = vi.fn<NonNullable<ChatDelivery["expand"]>>(async () => ({ attachments: files, directories: ["bag"] }));
    const download = vi.fn<NonNullable<ChatDelivery["download"]>>(async (_message, attachment) => {
      let received = 0;
      return { mime: "text/plain", bytes: attachment.bytes, progress: () => ({ received, transferred: received, total: attachment.bytes }),
        stream: Readable.from((async function* () { received = attachment.bytes!; yield Buffer.alloc(received); })()) };
    });
    const upload = vi.fn<NonNullable<ChatRuntime["upload"]>>(async (attachment, resource) => {
      const chunks = await resource.stream.toArray();
      if (attachment.key === "file_one") expect(bridge.control(fx.input("pause"))).toBe("accepted");
      return { kind: "file", path: `/store/${attachment.name}`, name: attachment.name, bytes: Buffer.concat(chunks).length };
    });
    const runtime = { ...fx.runtime, upload }, delivery = { ...fx.delivery, expand, download };
    const bridge = new ChatBridge({ ...fx, runtime, delivery });
    bridge.accept({ ...message, attachments: [{ kind: "folder", key: "file_bag", name: "bag" }] }); await bridge.tick();
    expect(fx.state.jobs[0]?.phase).toBe("paused"); await bridge.close();
    const state = new ChatState(fx.path, "fixture");
    const restarted = new ChatBridge({ ...fx, runtime, delivery, state });
    expect(restarted.control(fx.input("resume", 1))).toBe("accepted"); await restarted.tick();
    const views = fx.views.filter(view => view.download).map(view => view.download!);
    expect(views.some(view => view.index === 1 && view.received === 4 && view.overall?.received === 4 && view.overall.total === 10)).toBe(true);
    expect(views.some(view => view.index === 2 && view.received === 0 && view.overall?.received === 4 && view.overall.total === 10)).toBe(true);
    expect(views.at(-1)?.overall).toEqual({ received: 10, total: 10 });
    expect(new ChatState(fx.path, "fixture").jobs[0]?.preparedAttachments?.map(file => file.bytes)).toEqual([4, 6]);
    expect(expand).toHaveBeenCalledTimes(1); expect(download).toHaveBeenCalledTimes(2);
  });
  it("saves an attachment without inference and reuses its task and card when a description arrives after restart", async () => {
    const fx = cardFixture();
    const download = vi.fn(async () => ({ stream: Readable.from(["data"]), mime: "text/plain" }));
    const upload = vi.fn<NonNullable<ChatRuntime["upload"]>>(async (_attachment, resource) => { await resource.stream.toArray(); return { kind: "file", path: "/store/data.txt", name: "data.txt" }; });
    const runtime = { ...fx.runtime, upload }, delivery = { ...fx.delivery, download };
    const bridge = new ChatBridge({ ...fx, runtime, delivery });
    bridge.accept({ ...message, text: "", attachments: [{ kind: "file", key: "file_pending", name: "data.txt" }] }); await bridge.tick();
    expect(fx.state.jobs[0]?.phase).toBe("awaiting_description");
    expect(fx.runtime.createConversation).not.toHaveBeenCalled(); expect(fx.runtime.send).not.toHaveBeenCalled();
    expect(fx.views.at(-1)?.title).toBe("data.txt");
    expect(bridge.control(fx.input("pause"))).toBe("refused");
    await bridge.close();
    const state = new ChatState(fx.path, "fixture");
    const restarted = new ChatBridge({ ...fx, runtime, delivery, state });
    const description = { ...message, id: "om_description", replyToId: "om_card", text: "只确认能否读取，不要分析" };
    expect(restarted.accept(description)).toBe("accepted");
    fx.runtime.status.mockResolvedValue({ phase: "completed", text: "可以读取。" }); await restarted.tick();
    expect(state.jobs).toHaveLength(1); expect(download).toHaveBeenCalledTimes(1); expect(upload).toHaveBeenCalledTimes(1);
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
    expect(fx.runtime.send.mock.calls[0]?.[2]).toBe('只确认能否读取，不要分析\n\n<attached-file path="/store/data.txt" name="data.txt" />');
    expect(fx.delivery.present.mock.calls.every(call => !call[3] || call[3] === "om_card")).toBe(true);
    expect(restarted.accept(description)).toBe("duplicate");
  });

  it("combines a description received during transfer before making its first model request", async () => {
    const fx = cardFixture(), source = new Readable({ read() {} });
    const download = vi.fn(async () => ({ stream: source, mime: "text/plain" }));
    const upload = vi.fn<NonNullable<ChatRuntime["upload"]>>(async (_attachment, resource) => { await resource.stream.toArray(); return { kind: "file", path: "/store/data.txt", name: "data.txt" }; });
    const bridge = new ChatBridge({ ...fx, runtime: { ...fx.runtime, upload }, delivery: { ...fx.delivery, download } });
    bridge.accept({ ...message, text: "", attachments: [{ kind: "file", key: "file_pending", name: "data.txt" }] });
    const active = bridge.tick(); await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(fx.runtime.send).not.toHaveBeenCalled();
    bridge.accept({ ...message, id: "om_description", text: "Read this file" });
    source.push("data"); source.push(null); await active;
    expect(fx.state.jobs).toHaveLength(1); expect(fx.runtime.send).toHaveBeenCalledTimes(1);
    expect(fx.runtime.send.mock.calls[0]?.[2]).toContain("Read this file");
    expect(fx.views.some(view => view.phase === "awaiting_description")).toBe(false);
  });

  it("ends a pending upload from its card without starting or stopping an unrelated model request", async () => {
    const fx = cardFixture();
    const download = vi.fn(async () => ({ stream: Readable.from(["data"]), mime: "text/plain" }));
    const upload = vi.fn<NonNullable<ChatRuntime["upload"]>>(async (_attachment, resource) => { await resource.stream.toArray(); return { kind: "file", path: "/store/data", name: "data" }; });
    const bridge = new ChatBridge({ ...fx, runtime: { ...fx.runtime, upload }, delivery: { ...fx.delivery, download } });
    bridge.accept({ ...message, text: "", attachments: [{ kind: "file", key: "file_pending", name: "data" }] }); await bridge.tick();
    expect(bridge.control(fx.input("stop"))).toBe("accepted"); await bridge.tick();
    expect(fx.state.jobs[0]?.phase).toBe("stopped");
    expect(fx.runtime.send).not.toHaveBeenCalled(); expect(fx.runtime.stop).not.toHaveBeenCalled();
    expect(bridge.control(fx.input("resume", 1))).toBe("refused");
  });

  it("does not bind another user's description and resolves ambiguous pending uploads by explicit reply", async () => {
    const fx = fixture();
    fx.runtime.status.mockResolvedValue({ phase: "completed", text: "done" });
    const download = vi.fn(async () => ({ stream: Readable.from(["data"]), mime: "text/plain" }));
    const upload = vi.fn<NonNullable<ChatRuntime["upload"]>>(async (attachment, resource) => { await resource.stream.toArray(); return { kind: "file", path: `/store/${attachment.key}`, name: attachment.name }; });
    const bridge = new ChatBridge({ ...fx, runtime: { ...fx.runtime, upload }, delivery: { ...fx.delivery, download } });
    const group = { ...message, kind: "group" as const, threadId: "om_topic", text: "", attachments: [{ kind: "file" as const, key: "file_pending", name: "data.txt" }] };
    bridge.accept(group); await bridge.tick();
    bridge.accept({ ...group, id: "om_other", senderId: "ou_other", text: "Other user's request", attachments: undefined, replyToId: group.id }); await bridge.tick();
    expect(fx.state.jobs[0]?.phase).toBe("awaiting_description");
    expect(fx.runtime.send.mock.calls[0]?.[2]).not.toContain("/store/file_pending");
    bridge.accept({ ...group, id: "om_second", attachments: [{ kind: "file", key: "file_second", name: "second.txt" }] }); await bridge.tick();
    bridge.accept({ ...group, id: "om_ambiguous", attachments: undefined, text: "Read this" }); await bridge.tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(1); expect(fx.replies.at(-1)?.text).toContain("有多个待处理附件");
    bridge.accept({ ...group, id: "om_chosen", attachments: undefined, replyToId: "om_second", text: "Read only the second file" }); await bridge.tick();
    expect(fx.runtime.send.mock.calls[1]?.[2]).toContain("/store/file_second");
    expect(fx.runtime.send.mock.calls[1]?.[2]).not.toContain("/store/file_pending");
  });

  it("uses the only pending attachment when the same person continues the topic without quoting its file", async () => {
    const fx = fixture();
    const download = vi.fn(async () => ({ stream: Readable.from(["data"]), mime: "text/plain" }));
    const upload = vi.fn<NonNullable<ChatRuntime["upload"]>>(async (_attachment, resource) => { await resource.stream.toArray(); return { kind: "file", path: "/store/data", name: "data" }; });
    const bridge = new ChatBridge({ ...fx, runtime: { ...fx.runtime, upload }, delivery: { ...fx.delivery, download } });
    const group = { ...message, kind: "group" as const, threadId: "om_topic" };
    bridge.accept({ ...group, text: "", attachments: [{ kind: "file", key: "file_pending", name: "data" }] }); await bridge.tick();
    bridge.accept({ ...group, id: "om_followup", replyToId: "om_topic", text: "Just check whether this data is readable" }); await bridge.tick();
    expect(fx.state.jobs).toHaveLength(1);
    expect(fx.runtime.send.mock.calls[0]?.[2]).toContain("/store/data");
  });
  it("does not start the next folder file when paused as the previous save completes", async () => {
    const fx = cardFixture();
    const expand = vi.fn<NonNullable<ChatDelivery["expand"]>>(async () => ({ attachments: [
      { kind: "file", key: "file_first", name: "one.txt", sourcePath: "bag/one.txt" },
      { kind: "file", key: "file_second", name: "two.txt", sourcePath: "bag/two.txt" },
    ], directories: ["bag"] }));
    const download = vi.fn(async () => ({ stream: Readable.from(["data"]), mime: "text/plain" }));
    const upload = vi.fn<NonNullable<ChatRuntime["upload"]>>(async (attachment, resource) => {
      await resource.stream.toArray();
      if (attachment.key === "file_first") expect(bridge.control(fx.input("pause"))).toBe("accepted");
      return { kind: "file", path: `/store/${attachment.name}`, name: attachment.name, sourcePath: attachment.sourcePath };
    });
    const bridge = new ChatBridge({ ...fx, runtime: { ...fx.runtime, upload }, delivery: { ...fx.delivery, expand, download } });
    bridge.accept({ ...message, attachments: [{ kind: "folder", key: "file_folder", name: "bag" }] });
    await bridge.tick();
    expect(fx.state.jobs[0]!.phase).toBe("paused");
    expect(fx.state.jobs[0]!.preparedAttachments).toHaveLength(1);
    expect(download).toHaveBeenCalledTimes(1);
    expect(bridge.control(fx.input("resume", 1))).toBe("accepted"); await bridge.tick();
    expect(download).toHaveBeenCalledTimes(2);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
  });
  it("cancels folder enumeration from the card and restarts it only on continue", async () => {
    const fx = cardFixture();
    const expand = vi.fn<NonNullable<ChatDelivery["expand"]>>((_message, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new ChatRuntimeError("cancelled")), { once: true });
    }));
    const bridge = new ChatBridge({ ...fx, delivery: { ...fx.delivery, expand } });
    bridge.accept({ ...message, attachments: [{ kind: "folder", key: "file_folder", name: "bag" }] });
    const active = bridge.tick();
    await vi.waitFor(() => expect(expand).toHaveBeenCalledTimes(1));
    expect(bridge.control(fx.input("pause"))).toBe("accepted"); await active;
    expect(expand.mock.calls[0]![1].aborted).toBe(true);
    expect(fx.state.jobs[0]!.phase).toBe("paused");
    expect(fx.runtime.send).not.toHaveBeenCalled();
    expand.mockRejectedValueOnce(new ChatRuntimeError("denied", false, "permission"));
    expect(bridge.control(fx.input("resume", 1))).toBe("accepted"); await bridge.tick();
    expect(expand).toHaveBeenCalledTimes(2);
    expect(fx.state.jobs[0]).toMatchObject({ phase: "failed", attachmentFailure: "permission" });
  });
  it("publishes live status in one card, retains complete answers and falls back when card updates fail", async () => {
    const fx = cardFixture();
    fx.runtime.status.mockResolvedValue({ phase: "working", activity: "Reading the report" });
    fx.bridge.accept(message); await fx.bridge.tick();
    expect(fx.views.map(view => view.phase)).toEqual(["queued", "working"]);
    expect(fx.views.at(-1)!.detail).toBe("Reading the report");
    expect(fx.replies).toHaveLength(0);
    fx.delivery.present.mockRejectedValue(new Error("card update refused"));
    fx.runtime.status.mockResolvedValue({ phase: "waiting" });
    await fx.bridge.tick();
    expect(fx.replies.at(-1)!.text).toContain("审批");
    fx.runtime.status.mockResolvedValue({ phase: "completed", text: "complete report" });
    await fx.bridge.tick();
    expect(fx.replies.at(-1)!.text).toBe("complete report");
  });

  it("allows only the task owner on the original card to pause, resumes after restart and rejects replayed buttons", async () => {
    const fx = cardFixture();
    fx.bridge.accept(message); await fx.bridge.tick();
    const input = fx.input("pause");
    expect(fx.bridge.control({ ...input, senderId: "ou_other" })).toBe("refused");
    expect(fx.bridge.control({ ...input, chatId: "oc_other" })).toBe("refused");
    expect(fx.bridge.control({ ...input, messageId: "om_other" })).toBe("refused");
    expect(fx.bridge.control(input)).toBe("accepted");
    expect(fx.bridge.control(input)).toBe("refused");
    await fx.bridge.tick();
    expect(fx.state.jobs[0]!.phase).toBe("paused");
    expect(fx.runtime.stop).toHaveBeenCalledWith("thread-1", fx.state.jobs[0]!.id);
    const state = new ChatState(fx.path, "fixture");
    const bridge = new ChatBridge({ ...fx, state });
    expect(bridge.control(fx.input("resume", 1))).toBe("accepted");
    await bridge.tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(2);
    expect(fx.runtime.send.mock.calls[1]![0]).toBe("thread-1");
    expect(fx.runtime.send.mock.calls[1]![1]).not.toBe(fx.runtime.send.mock.calls[0]![1]);
    expect(fx.runtime.send.mock.calls[1]![2]).toContain("避免重复执行");
    expect(bridge.control(fx.input("resume", 1))).toBe("refused");
    expect(bridge.control(fx.input("stop", 2))).toBe("accepted");
    await bridge.tick();
    expect(fx.runtime.stop.mock.calls[1]![1]).toBe(fx.runtime.send.mock.calls[1]![1]);
    expect(state.jobs[0]!.phase).toBe("stopped");
  });

  it("holds later messages while paused and refuses to resume onto a changed conversation", async () => {
    const fx = cardFixture(); fx.bridge.accept(message); await fx.bridge.tick();
    fx.bridge.control(fx.input("pause")); await fx.bridge.tick();
    fx.bridge.accept({ ...message, id: "om_later" }); await fx.bridge.tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
    fx.runtime.prepare.mockResolvedValue({ activeLeafId: "other-branch", approvalMode: "full" });
    fx.bridge.control(fx.input("resume", 1)); await fx.bridge.tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
    expect(fx.state.jobs[0]!.phase).toBe("failed");
  });

  it("preserves a proven completion when the user clicks stop after the task finishes", async () => {
    const fx = cardFixture(); fx.bridge.accept(message); await fx.bridge.tick();
    fx.bridge.control(fx.input("stop"));
    fx.runtime.status.mockResolvedValue({ phase: "completed", text: "already finished" });
    await fx.bridge.tick();
    expect(fx.runtime.stop).not.toHaveBeenCalled();
    expect(fx.replies.at(-1)!.text).toBe("already finished");
    expect(fx.views.at(-1)!.phase).toBe("completed");
  });

  it("cancels a queued task without stopping the earlier request in the same conversation", async () => {
    const fx = cardFixture(); fx.bridge.accept(message); await fx.bridge.tick();
    fx.bridge.accept({ ...message, id: "om_queued" }); await fx.bridge.tick();
    const job = fx.state.jobs[1]!;
    expect(fx.bridge.control({ ...fx.input("stop"), jobId: job.id })).toBe("accepted");
    await fx.bridge.tick();
    expect(job.phase).toBe("stopped");
    expect(fx.state.jobs[0]!.phase).toBe("working");
    expect(fx.runtime.stop).not.toHaveBeenCalled();
  });

  it("recovers a paused request when the interrupt succeeded but its acknowledgement was lost", async () => {
    const fx = cardFixture(); fx.bridge.accept(message); await fx.bridge.tick();
    fx.runtime.stop.mockRejectedValueOnce(new ChatRuntimeError("lost acknowledgement", true));
    fx.bridge.control(fx.input("pause")); await fx.bridge.tick();
    const state = new ChatState(fx.path, "fixture"); state.jobs[0]!.retryAt = 0;
    fx.runtime.status.mockResolvedValue({ phase: "stopped" });
    await new ChatBridge({ ...fx, state }).tick();
    expect(state.jobs[0]!.phase).toBe("paused");
    expect(fx.runtime.stop).toHaveBeenCalledTimes(1);
  });
  it("drops a saved resume control when access is revoked before restart", async () => {
    const fx = cardFixture(); fx.bridge.accept(message); await fx.bridge.tick();
    fx.bridge.control(fx.input("pause")); await fx.bridge.tick();
    fx.bridge.control(fx.input("resume", 1));
    const state = new ChatState(fx.path, "fixture");
    await new ChatBridge({ ...fx, state, allowed: () => false }).tick();
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
    expect(state.jobs[0]!.control).toBeUndefined();
    expect(delivered(state.jobs[0]!)).toBe(true);
  });

  it("interrupts a download before inference and resumes the original request with the same upload ID", async () => {
    const fx = cardFixture();
    const source = new Readable({ read() {} }); source.push(Buffer.from("part"));
    const download = vi.fn().mockResolvedValueOnce({ stream: source, mime: "text/plain", bytes: 8 })
      .mockResolvedValueOnce({ stream: Readable.from([Buffer.from("complete")]), mime: "text/plain", bytes: 8 });
    const upload = vi.fn<NonNullable<ChatRuntime["upload"]>>(async (_attachment, resource) => {
      await resource.stream.toArray();
      return { kind: "file", path: "/store/file.txt", name: "file.txt" };
    });
    const bridge = new ChatBridge({ ...fx, runtime: { ...fx.runtime, upload }, delivery: { ...fx.delivery, download } });
    bridge.accept({ ...message, text: "Read this file", attachments: [{ kind: "file", key: "file_fixture", name: "file.txt" }] });
    const active = bridge.tick();
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(bridge.control(fx.input("pause"))).toBe("accepted");
    await active;
    expect(source.destroyed).toBe(true);
    expect(fx.state.jobs[0]!.phase).toBe("paused");
    expect(fx.runtime.send).not.toHaveBeenCalled();
    expect(bridge.control(fx.input("resume", 1))).toBe("accepted");
    await bridge.tick();
    expect(upload.mock.calls[0]![2]).toBe(upload.mock.calls[1]![2]);
    expect(fx.runtime.send.mock.calls[0]![2]).toContain("Read this file");
    expect(fx.runtime.send.mock.calls[0]![2]).toContain("/store/file.txt");
    expect(fx.views.some(view => view.phase === "downloading" && view.download?.total === 8)).toBe(true);
  });
});

describe("durable messaging bridge", () => {
  it("persists an expanded folder and reuses completed file receipts after a partial-batch restart", async () => {
    const fx = fixture();
    const files = Array.from({ length: 6 }, (_, i) => ({ kind: "file" as const, key: `file_${i}`, name: "metadata.yaml", sourcePath: `bag/${i}/metadata.yaml` }));
    const expand = vi.fn<NonNullable<ChatDelivery["expand"]>>(async () => ({ attachments: files, directories: ["bag"] }));
    const download = vi.fn(async () => ({ stream: Readable.from(["data"]), mime: "text/plain" }));
    let interrupted = false;
    const upload = vi.fn<NonNullable<ChatRuntime["upload"]>>(async (attachment, resource, id) => {
      await resource.stream.toArray();
      if (attachment.key === "file_1" && !interrupted) { interrupted = true; throw new ChatRuntimeError("connection lost", true, "network"); }
      return { kind: "file", name: attachment.name, sourcePath: attachment.sourcePath, path: `/store/${id}.yaml` };
    });
    const runtime = { ...fx.runtime, upload }, delivery = { ...fx.delivery, download, expand };
    const bridge = new ChatBridge({ ...fx, runtime, delivery });
    bridge.accept({ ...message, attachments: [{ kind: "folder", key: "file_folder", name: "bag" }] });
    await bridge.tick(); await bridge.close();
    const state = new ChatState(fx.path, "fixture");
    expect(state.jobs[0]!.expandedAttachments).toHaveLength(6);
    expect(state.jobs[0]!.preparedAttachments).toHaveLength(1);
    state.jobs[0]!.retryAt = 0;
    fx.runtime.status.mockResolvedValue({ phase: "completed", text: "done" });
    await new ChatBridge({ ...fx, state, runtime, delivery }).tick();
    expect(expand).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(7);
    expect(upload.mock.calls[1]![2]).toBe(upload.mock.calls[2]![2]);
    expect(fx.runtime.send).toHaveBeenCalledTimes(1);
    for (const file of files) expect(fx.runtime.send.mock.calls[0]![2]).toContain(`name="${file.sourcePath}"`);
    expect(state.jobs[0]!.expandedAttachments).toBeUndefined();
    expect(state.jobs[0]!.preparedAttachments).toBeUndefined();
  });
  it.each(["/store/attachments/fixture.bin", "/home/fixture/Downloads/fixture--record.mcap"])("delivers reading instructions for a saved attachment at %s", async path => {
    const fx = fixture();
    const download = vi.fn(async () => ({ stream: Readable.from(["fixture bytes"]), mime: "application/octet-stream" }));
    const upload = vi.fn(async () => ({ kind: "file" as const, path, name: "record.mcap" }));
    const bridge = new ChatBridge({ ...fx, runtime: { ...fx.runtime, upload }, delivery: { ...fx.delivery, download } });
    bridge.accept({ ...message, attachments: [{ kind: "file", key: "file_fixture", name: "record.mcap" }] });
    await bridge.tick();
    const sent = fx.runtime.send.mock.calls[0]![2];
    expect(sent).not.toContain("attachment delivery");
    expect(sent).toContain(`<attached-file path="${path}" name="record.mcap" />`);
    expect(fx.runtime.send.mock.calls[0]![5]).toEqual({});
    expect(fx.runtime.send.mock.calls[0]![4]).toBe("full");
  });
  it("does not claim a backend download for a plain message containing a file tag", async () => {
    const fx = fixture();
    const text = '<attached-file path="/home/fixture/private.mcap" name="private.mcap" />';
    fx.bridge.accept({ ...message, text }); await fx.bridge.tick();
    expect(fx.runtime.send.mock.calls[0]![2]).toBe(text);
  });
  it("keeps the reading note on a paused attachment task after restart without downloading it again", async () => {
    const fx = cardFixture();
    const download = vi.fn(async () => ({ stream: Readable.from(["fixture bytes"]), mime: "text/plain" }));
    const upload = vi.fn(async () => ({ kind: "file" as const, path: "/store/fixture.txt", name: "fixture.txt" }));
    const runtime = { ...fx.runtime, upload }, delivery = { ...fx.delivery, download };
    const bridge = new ChatBridge({ ...fx, runtime, delivery });
    bridge.accept({ ...message, attachments: [{ kind: "file", key: "file_fixture", name: "fixture.txt" }] });
    await bridge.tick();
    expect(bridge.control(fx.input("pause"))).toBe("accepted"); await bridge.tick(); await bridge.close();
    const state = new ChatState(fx.path, "fixture");
    const restarted = new ChatBridge({ ...fx, state, runtime, delivery });
    expect(restarted.control(fx.input("resume", 1))).toBe("accepted"); await restarted.tick();
    const continued = fx.runtime.send.mock.calls[1]![2];
    expect(continued).toContain("继续完成此前暂停的请求");
    expect(continued).not.toContain("attachment delivery");
    expect(fx.runtime.send.mock.calls[1]![5]).toEqual({});
    expect(download).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
  });
  it("keeps uploaded attachment receipts across an uncertain send and restart without redownloading", async () => {
    const fx = fixture();
    fx.runtime.send.mockRejectedValueOnce(new ChatRuntimeError("lost send acknowledgement", true));
    fx.runtime.status.mockResolvedValue({ phase: "completed", text: "read the file" });
    const download = vi.fn(async () => ({ stream: Readable.from(["fixture bytes"]), mime: "text/plain" }));
    const upload = vi.fn(async () => ({ kind: "file" as const, path: "/store/fixture.txt", name: "Report & notes.txt" }));
    const bridge = new ChatBridge({ ...fx, runtime: { ...fx.runtime, upload }, delivery: { ...fx.delivery, download } });
    bridge.accept({ ...message, attachments: [{ kind: "file", key: "file_fixture", name: "report.txt" }] });
    await bridge.tick();
    const restored = new ChatState(fx.path, "fixture"); restored.jobs[0]!.retryAt = 0;
    await new ChatBridge({ ...fx, state: restored, runtime: { ...fx.runtime, upload }, delivery: { ...fx.delivery, download } }).tick();
    expect(download).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(fx.runtime.send.mock.calls[0]).toEqual(fx.runtime.send.mock.calls[1]);
    expect(fx.runtime.send.mock.calls[0]![2]).toContain('<attached-file path="/store/fixture.txt" name="Report &amp; notes.txt" />');
  });
  it("reports attachment download failures without starting the model or leaking vendor errors", async () => {
    const fx = fixture();
    const download = vi.fn(async () => { throw new ChatRuntimeError("private provider details", false, "download"); });
    const upload = vi.fn();
    const bridge = new ChatBridge({ ...fx, runtime: { ...fx.runtime, upload }, delivery: { ...fx.delivery, download } });
    bridge.accept({ ...message, attachments: [{ kind: "file", key: "file_fixture", name: "report.txt" }] });
    await bridge.tick();
    expect(fx.runtime.createConversation).not.toHaveBeenCalled();
    expect(fx.runtime.send).not.toHaveBeenCalled();
    expect(fx.replies[0]!.text).toContain("附件下载失败");
    expect(fx.replies[0]!.text).not.toContain("private provider");
  });
  it("resumes a partial attachment batch with the same upload receipt after restart", async () => {
    const fx = fixture();
    const download = vi.fn(async () => ({ stream: Readable.from(["bytes"]), mime: "text/plain" }));
    const upload = vi.fn<NonNullable<ChatRuntime["upload"]>>()
      .mockResolvedValueOnce({ kind: "file", path: "/store/one.txt", name: "one.txt" })
      .mockRejectedValueOnce(new ChatRuntimeError("temporary storage failure", true, "upload"))
      .mockResolvedValueOnce({ kind: "file", path: "/store/two.txt", name: "two.txt" });
    const runtime = { ...fx.runtime, upload }, delivery = { ...fx.delivery, download };
    const bridge = new ChatBridge({ ...fx, runtime, delivery });
    bridge.accept({ ...message, attachments: [
      { kind: "file", key: "file_one", name: "one.txt" },
      { kind: "file", key: "file_two", name: "two.txt" },
    ] });
    await bridge.tick();
    expect(fx.runtime.send).not.toHaveBeenCalled();
    const state = new ChatState(fx.path, "fixture");
    expect(state.jobs[0]!.preparedAttachments).toEqual([{ kind: "file", path: "/store/one.txt", name: "one.txt" }]);
    state.jobs[0]!.retryAt = 0;
    await new ChatBridge({ ...fx, state, runtime, delivery }).tick();
    expect(download.mock.calls).toHaveLength(3);
    expect(upload.mock.calls[1]![2]).toBe(upload.mock.calls[2]![2]);
    expect(upload.mock.calls[0]![2]).not.toBe(upload.mock.calls[1]![2]);
    expect(fx.runtime.send.mock.calls[0]![2]).toContain("/store/one.txt");
    expect(fx.runtime.send.mock.calls[0]![2]).toContain("/store/two.txt");
  });
  it("recognizes admitted topic routes before dispatch and after restart without admitting other chats or apps", async () => {
    const fx = fixture();
    const group: ChatMessage = { ...message, kind: "group", threadId: "om_root" };
    expect(fx.state.hasRoute(group)).toBe(false);
    fx.bridge.accept(group);
    const followup = { ...group, id: "om_followup" };
    expect(fx.state.hasRoute(followup)).toBe(true);
    expect(new ChatState(fx.path, "fixture").hasRoute(followup)).toBe(true);
    await fx.bridge.tick();
    const restarted = new ChatState(fx.path, "fixture");
    expect(restarted.hasRoute(followup)).toBe(true);
    expect(restarted.hasRoute({ ...followup, threadId: "om_unrelated" })).toBe(false);
    expect(restarted.hasRoute({ ...followup, chatId: "oc_other" })).toBe(false);
    expect(restarted.hasRoute({ ...followup, account: "another-app" })).toBe(false);
  });
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
    const fx = fixture(); fx.bridge.accept({ ...message, attachments: [{ kind: "file", key: "file_fixture", name: "report.txt" }] });
    const state = new ChatState(fx.path, "fixture");
    const download = vi.fn(), upload = vi.fn();
    const bridge = new ChatBridge({ ...fx, state, runtime: { ...fx.runtime, upload }, delivery: { ...fx.delivery, download }, allowed: () => false });
    await bridge.tick();
    expect(download).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(fx.runtime.createConversation).not.toHaveBeenCalled();
    expect(fx.runtime.send).not.toHaveBeenCalled();
    expect(fx.delivery.reply).not.toHaveBeenCalled();
    expect(delivered(state.jobs[0]!)).toBe(true);
    expect(state.jobs[0]!.message.attachments).toBeUndefined();
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
