import { describe, expect, it, vi } from "vitest";
import { OpenMausBotChatRuntime } from "./openmausbot.ts";
import { ChatRuntimeError } from "./contracts.ts";

const source = { messageId: "request", activeLeafId: "reply", activeTurnId: null, executionId: null, phase: "settled", messages: [
  { role: "bot", kind: "text", text: "earlier handoff" }, { role: "bot", kind: "text", text: "proven result", turnTerminal: true, turnSucceeded: true },
] };
function runtime(value: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }));
  return { runtime: new OpenMausBotChatRuntime({ url: "http://127.0.0.1:9876", botId: "bot", token: "fixture-token", fetch: fetcher }), fetcher };
}

describe("OpenMausBot messaging runtime", () => {
  it.each(["http://example.test", "https://cloud.example.test", "http://127.0.0.1/another", "http://user:secret@127.0.0.1", "file:///tmp/app"])("refuses non-local or ambiguous destinations %s", url => {
    expect(() => new OpenMausBotChatRuntime({ url, botId: "bot", token: "secret" })).toThrow();
  });
  it("returns only a successful terminal reply from the request's snapshot", async () => {
    expect(await runtime(source).runtime.status("thread", "fixture-send-id-0001")).toEqual({ phase: "completed", text: "proven result" });
    expect(await runtime({ ...source, phase: "untracked" }).runtime.status("thread", "fixture-send-id-0001")).toEqual({ phase: "failed" });
    expect(await runtime({ ...source, phase: "waiting" }).runtime.status("thread", "fixture-send-id-0001")).toEqual({ phase: "waiting" });
    expect(await runtime({ ...source, messages: [] }).runtime.status("thread", "fixture-send-id-0001")).toEqual({ phase: "failed" });
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
