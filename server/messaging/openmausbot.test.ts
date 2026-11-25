import { describe, expect, it, vi } from "vitest";
import { OpenMausBotChatRuntime } from "./openmausbot.ts";
import { ChatRuntimeError } from "./contracts.ts";
import { Readable } from "node:stream";

const source = { messageId: "request", activeLeafId: "reply", activeTurnId: null, executionId: null, phase: "settled", messages: [
  { role: "bot", kind: "text", text: "earlier handoff" }, { role: "bot", kind: "text", text: "proven result", turnTerminal: true, turnSucceeded: true },
] };
function runtime(value: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async (url, options) => options?.method === "GET" && String(url).endsWith("/api/feishu/files")
    ? new Response(JSON.stringify({ maxFileBytes: 512 * 1024 * 1024 }))
    : new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }));
  return { runtime: new OpenMausBotChatRuntime({ url: "http://127.0.0.1:9876", botId: "bot", token: "fixture-token", fetch: fetcher }), fetcher };
}

describe("OpenMausBot messaging runtime", () => {
  it("sends attachment delivery metadata separately from the visible request", async () => {
    const fx = runtime({});
    await fx.runtime.send("thread", "send-0123456789abcdef", "确认附件能否读取。", null, "full", { directory: "/home/fixture/Downloads/batch" });
    expect(JSON.parse(String(fx.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      text: "确认附件能否读取。", attachmentContext: { directory: "/home/fixture/Downloads/batch" }, expectedApprovalMode: "full",
    });
  });
  it("streams attachments to the local upload API with a stable upload ID and header credentials", async () => {
    const fx = runtime({});
    let received = "";
    fx.fetcher.mockImplementation(async (_url, options) => {
      if (options?.method === "GET") return new Response(JSON.stringify({ maxFileBytes: 512 * 1024 * 1024 }));
      received = await new Response(options?.body).text();
      return new Response(JSON.stringify({ path: "/store/fixture.txt", name: "report.txt" }), { status: 201 });
    });
    expect(await fx.runtime.upload({ kind: "file", key: "file_fixture", name: "report.txt" }, { stream: Readable.from(["part one", "part two"]), mime: "text/plain" }, "11111111-1111-5111-a111-111111111111"))
      .toEqual({ kind: "file", path: "/store/fixture.txt", name: "report.txt" });
    expect(received).toBe("part onepart two");
    const [url, options] = fx.fetcher.mock.calls[1]!;
    expect(String(url)).toContain("/api/feishu/files?uploadId=11111111-1111-5111-a111-111111111111&name=report.txt");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fixture-token");
  });
  it.each(["http://example.test", "https://cloud.example.test", "http://127.0.0.1/another", "http://user:secret@127.0.0.1", "file:///tmp/app"])("refuses non-local or ambiguous destinations %s", url => {
    expect(() => new OpenMausBotChatRuntime({ url, botId: "bot", token: "secret" })).toThrow();
  });
  it("stops oversized image streams even without a declared content length", async () => {
    const fx = runtime({});
    fx.fetcher.mockImplementation(async (_url, options) => {
      await new Response(options?.body).arrayBuffer();
      return new Response("{}");
    });
    const stream = Readable.from((async function* () {
      const chunk = Buffer.alloc(1024 * 1024);
      for (let index = 0; index < 11; index++) yield chunk;
    })());
    await expect(fx.runtime.upload({ kind: "image", key: "img_fixture", name: "image.png" }, { stream, mime: "image/png" }, "11111111-1111-5111-a111-111111111111"))
      .rejects.toMatchObject({ attachmentFailure: "size", retryable: false });
    expect(stream.destroyed).toBe(true);
  });
  it("streams a file above 100 MiB to the local connector endpoint without buffering the complete body", async () => {
    const fx = runtime({});
    const total = 101 * 1024 * 1024;
    let bytes = 0;
    fx.fetcher.mockImplementation(async (_url, options) => {
      if (options?.method === "GET") return new Response(JSON.stringify({ maxFileBytes: 512 * 1024 * 1024 }));
      for await (const chunk of Readable.fromWeb(options!.body as ReadableStream)) bytes += chunk.length;
      return new Response(JSON.stringify({ path: "/store/big.bin", name: "data.mcap" }), { status: 201 });
    });
    const stream = Readable.from((async function* () { const chunk = Buffer.alloc(1024 * 1024); for (let index = 0; index < 101; index++) yield chunk; })());
    expect(await fx.runtime.upload({ kind: "file", key: "file_big", name: "data.mcap" }, { stream, mime: "application/octet-stream", bytes: total }, "11111111-1111-5111-a111-111111111111"))
      .toMatchObject({ path: "/store/big.bin" });
    expect(bytes).toBe(total);
    expect(new Headers(fx.fetcher.mock.calls[1]![1]?.headers).get("content-length")).toBe(String(total));
  });
  it.each([[507, "storage"], [413, "size"], [403, "upload"]] as const)("classifies local save refusal %s", async (status, attachmentFailure) => {
    const fx = runtime({}, status);
    await expect(fx.runtime.upload({ kind: "file", key: "file_big", name: "data.mcap" }, { stream: Readable.from([Buffer.from("x")]), mime: "application/octet-stream" }, "11111111-1111-5111-a111-111111111111"))
      .rejects.toMatchObject({ attachmentFailure, retryable: false });
  });
  it("returns only a successful terminal reply from the request's snapshot", async () => {
    expect(await runtime(source).runtime.status("thread", "fixture-send-id-0001")).toEqual({ phase: "completed", text: "proven result" });
    expect(await runtime({ ...source, phase: "untracked" }).runtime.status("thread", "fixture-send-id-0001")).toEqual({ phase: "failed" });
    expect(await runtime({ ...source, phase: "waiting" }).runtime.status("thread", "fixture-send-id-0001")).toMatchObject({ phase: "waiting" });
    expect(await runtime({ ...source, messages: [] }).runtime.status("thread", "fixture-send-id-0001")).toEqual({ phase: "failed" });
  });
  it("exposes public text and tool names as activity without forwarding tool inputs or results", async () => {
    const working = { ...source, phase: "working", messages: [{ role: "bot", kind: "activity", tool: { name: "Read", input: { token: "private-token" }, result: "private-result" } }] };
    const status = await runtime(working).runtime.status("thread", "fixture-send-id-0001");
    expect(status).toEqual({ phase: "working", activity: "正在执行：Read" });
    expect(JSON.stringify(status)).not.toContain("private");
  });
  it("resumes only a cancelled request's own branch after its execution has stopped", async () => {
    const stopped = { ...source, phase: "untracked", messages: [{ role: "user", kind: "text", requestCancelled: true }] };
    const fx = runtime(stopped);
    fx.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(stopped)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ activeLeafId: stopped.activeLeafId, approvalMode: "ask" })));
    expect(await fx.runtime.checkpoint("thread", "fixture-send-id-0001")).toEqual({ activeLeafId: stopped.activeLeafId, approvalMode: "ask" });
    expect(fx.fetcher.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    await expect(runtime({ ...stopped, activeTurnId: "still-stopping" }).runtime.checkpoint("thread", "fixture-send-id-0001")).rejects.toMatchObject({ retryable: true });
    await expect(runtime(source).runtime.checkpoint("thread", "fixture-send-id-0001")).rejects.toMatchObject({ retryable: false });
    await expect(runtime({ code: "guarded_request_changed" }, 409).runtime.checkpoint("thread", "fixture-send-id-0001")).rejects.toMatchObject({ retryable: false });
  });
  it("pins an owned send to its saved branch and approval mode, uses a header token and refuses redirects", async () => {
    const fx = runtime({ ok: true });
    await fx.runtime.send("thread", "fixture-send-id-0001", "hello", "leaf", "full");
    const [url, options] = fx.fetcher.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:9876/api/bots/bot/messages/owned");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fixture-token");
    expect(JSON.parse(String(options?.body))).toEqual({ threadId: "thread", sendId: "fixture-send-id-0001", text: "hello", expectedActiveLeafId: "leaf", expectedApprovalMode: "full" });
  });
  it("keeps an uncertain legacy relay a relay instead of upgrading its authority on restart", async () => {
    const fx = runtime({ ok: true });
    await fx.runtime.send("thread", "fixture-send-id-0001", "hello", "leaf");
    expect(fx.fetcher.mock.calls[0]![0]).toBe("http://127.0.0.1:9876/api/bots/bot/messages/guarded");
    expect(JSON.parse(String(fx.fetcher.mock.calls[0]![1]?.body)).expectedApprovalMode).toBe("ask");
  });
  it("creates a conversation without overriding its bot's permissions and reads effective task permissions", async () => {
    const fx = runtime({ task: { threadId: "thread" } });
    await fx.runtime.createConversation("Feishu request");
    expect(JSON.parse(String(fx.fetcher.mock.calls[0]![1]?.body))).toEqual({ title: "Feishu request", select: false });
    const prepared = runtime({ activeLeafId: "leaf", approvalMode: "edits" });
    expect(await prepared.runtime.prepare("thread")).toEqual({ activeLeafId: "leaf", approvalMode: "edits" });
    expect(prepared.fetcher.mock.calls[0]![0]).toBe("http://127.0.0.1:9876/api/bots/bot/messages/owned?threadId=thread");
  });
  it("retries busy and unreachable runtimes but does not refresh a rejected branch", async () => {
    await expect(runtime({ code: "guarded_busy" }, 409).runtime.send("t", "fixture-send-id-0001", "x", null)).rejects.toMatchObject({ retryable: true });
    await expect(runtime({ code: "guarded_branch" }, 409).runtime.send("t", "fixture-send-id-0001", "x", null)).rejects.toMatchObject({ retryable: false });
    await expect(runtime({ code: "guarded_permissions" }, 409).runtime.send("t", "fixture-send-id-0001", "x", null)).rejects.toMatchObject({ retryable: false });
    await expect(runtime({ error: "secret should not be forwarded" }, 403).runtime.send("t", "fixture-send-id-0001", "x", null)).rejects.not.toThrow("secret");
  });
  it("fences Stop to the exact execution and never falls back to a general interrupt", async () => {
    const fx = runtime({ ...source, phase: "working", activeTurnId: "turn", executionId: "execution" });
    await fx.runtime.stop("thread", "fixture-send-id-0001");
    expect(fx.fetcher.mock.calls).toHaveLength(2);
    const [url, options] = fx.fetcher.mock.calls[1]!;
    expect(url).toContain("/requests/fixture-send-id-0001/interrupt");
    expect(JSON.parse(String(options?.body))).toEqual({ threadId: "thread", messageId: "request", expectedActiveLeafId: "reply", expectedTurnId: "turn", expectedExecutionId: "execution" });
    const ended = runtime(source);
    await expect(ended.runtime.stop("thread", "fixture-send-id-0001")).rejects.toBeInstanceOf(ChatRuntimeError);
    expect(ended.fetcher).toHaveBeenCalledTimes(1);
  });
});
