import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../../scripts/control-omb.ts";
import { ChatBridge } from "../messaging/bridge.ts";
import { ChatState, delivered } from "../messaging/state.ts";
import { OpenMausBotChatRuntime } from "../messaging/openmausbot.ts";
import { FakeFeishu } from "../testing/fake-feishu.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { feishuConfigSchema } from "./config.ts";
import { feishuMessage } from "./events.ts";
import type { FeishuTransport } from "./transport.ts";
import { isTitleCall } from "../testing/title-call.ts";

let fixture: VerificationServer;
let platform: FakeFeishu;
let transport: FeishuTransport;
let runtime: OpenMausBotChatRuntime;
let state: ChatState;
let bridge: ChatBridge;
let botId = "";
let root = "";
const evidence: unknown[] = [];
const runtimeFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  evidence.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined, status: response.status, result: await response.clone().json() });
  return response;
};
const config = feishuConfigSchema.parse({ appId: "cli_0123456789abcdef", botId: "placeholder", url: "http://127.0.0.1:8799", allowedUsers: ["ou_alice"], allowedChats: ["oc_group"] });
const raw = (id: string, text: string, group = false, root?: string) => ({
  sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } }, message: {
    message_id: id, chat_id: group ? "oc_group" : "oc_direct", chat_type: group ? "group" : "p2p", message_type: "text",
    content: JSON.stringify({ text: `${group ? "@_user_1 " : ""}${text}` }),
    ...(group ? { mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }], ...(root ? { root_id: root } : {}) } : {}),
  },
});
type FixturePage = { messages: { role: string; card?: { requestId?: string; answered?: unknown } }[] };
const api = async <T = unknown>(path: string) => {
  const result = await (await fetch(`${fixture.info.url}${path}`)).json() as T;
  evidence.push({ path, result }); return result;
};
const request = async <T = unknown>(method: string, path: string, body?: unknown, token?: string) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method,
    headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = { status: response.status, body: await response.json() as T };
  evidence.push({ method, path, status: result.status, result: result.body });
  return result;
};
async function settle() {
  await expect.poll(async () => { await bridge.tick(); return state.jobs.every(delivered); }, { timeout: 30_000, interval: 100 }).toBe(true);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omb-feishu-fixture-"));
  writeFileSync(join(root, "reply.txt"), "飞书隔离测试完成");
  writeFileSync(join(root, "calls.json"), "[]");
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TOOL_CALLS_FILE: join(root, "calls.json"), FAKE_CLAUDE_REPLY_FILE: join(root, "reply.txt") });
  const made = await runControlOmb(["new-bot", "--name", "Feishu fixture", "--url", fixture.info.url]) as { bot: { id: string } };
  botId = made.bot.id;
  const tokenFile = join(fixture.info.dataDir, "bridge-token");
  await runControlOmb(["connect", fixture.info.url, "--out", tokenFile]);
  runtime = new OpenMausBotChatRuntime({ url: fixture.info.url, botId, token: readFileSync(tokenFile, "utf8").trim(), fetch: runtimeFetch });
  await runtime.connect();
  platform = new FakeFeishu(); await platform.listen();
  transport = platform.transport(config);
  expect(await transport.identity()).toBe("ou_bot");
  state = new ChatState(join(fixture.info.dataDir, "feishu-state.json"), "fixture");
  bridge = new ChatBridge({ runtime, delivery: transport, state });
  await transport.start(event => {
    const message = feishuMessage(event, config, "ou_bot");
    if (message) bridge.accept(message);
  });
}, 60_000);

afterAll(async () => {
  transport?.close();
  await bridge?.close();
  if (fixture) {
    const evidencePath = `${fixture.info.logPath}.feishu.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, jobs: state?.jobs, replies: platform?.replies,
      limitation: "Isolated runtime, fake Claude and loopback chat-completions providers, actual SDK event dispatcher and HTTP client against loopback Feishu stand-in. No live accounts or real WebSocket handshake." }, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
  }
  await platform?.close();
  await fixture?.close();
  if (root) await removeTempDir(root);
});

it("receives a DM through the SDK dispatcher, runs a pinned request and replies through the Feishu API", async () => {
  const stranger = raw("om_stranger", "Unbound sender must not start a task");
  stranger.sender.sender_id.open_id = "ou_stranger";
  await platform.emit(stranger);
  await bridge.tick();
  expect(state.jobs).toHaveLength(0);
  await platform.emit(raw("om_dm_1", "DM fixture request"));
  await settle();
  expect(state.jobs).toHaveLength(1);
  const thread = state.jobs[0]!.threadId!;
  const page = await api(`/api/threads/${thread}/messages?limit=100`) as { messages: { role: string; text?: string; relayed?: boolean; sender?: { id?: string }; turnTerminal?: boolean }[] };
  const own = page.messages.find(message => message.role === "user")!;
  expect(own.text).toBe("DM fixture request");
  expect(own.relayed).toBeUndefined();
  expect(own.sender?.id).toMatch(/^p_/);
  const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  expect(JSON.stringify(dump.prompt)).not.toContain("information only");
  expect(JSON.stringify(dump.prompt)).not.toContain("relayed by another app");
  expect(dump.argv).toContain("bypassPermissions");
  expect(page.messages.some(message => message.role === "bot" && message.turnTerminal)).toBe(true);
  expect(platform.replies.some(reply => reply.messageId === "om_dm_1" && reply.text === "飞书隔离测试完成")).toBe(true);
  await platform.emit(raw("om_dm_1", "DM fixture request")); await bridge.tick();
  expect(state.jobs).toHaveLength(1);
});

it("reuses a DM after bridge restart and keeps each mentioned group topic separate", async () => {
  const first = state.jobs[0]!.threadId;
  await bridge.close();
  state = new ChatState(join(fixture.info.dataDir, "feishu-state.json"), "fixture");
  bridge = new ChatBridge({ runtime, delivery: transport, state });
  await platform.emit(raw("om_dm_2", "DM continuation"));
  await platform.emit(raw("om_group_1", "group topic" , true));
  await platform.emit(raw("om_group_2", "another group topic", true));
  await settle();
  expect(state.jobs[1]!.threadId).toBe(first);
  expect(new Set([first, state.jobs[2]!.threadId, state.jobs[3]!.threadId]).size).toBe(3);
  await platform.emit(raw("om_group_follow", "topic continuation", true, "om_group_1"));
  await settle();
  expect(state.jobs.at(-1)!.threadId).toBe(state.jobs[2]!.threadId);
  expect(platform.replies.filter(reply => reply.messageId.startsWith("om_group")).every(reply => reply.inThread)).toBe(true);
  await runControlOmb(["messages", "--bot", botId, "--task", first!, "--url", fixture.info.url]);
});

it("queues a second DM without steering the first and safely retries a lost platform reply", async () => {
  platform.failNextReply = true;
  await platform.emit(raw("om_queue_1", "queued first"));
  await platform.emit(raw("om_queue_2", "queued second"));
  await bridge.tick();
  expect(state.jobs.at(-1)!.phase).toBe("queued");
  await settle();
  const id = state.jobs.at(-1)!.threadId!;
  const page = await api(`/api/threads/${id}/messages?limit=100`) as { messages: { role: string; text: string; steered?: boolean }[] };
  expect(page.messages.filter(message => message.role === "user" && message.text.startsWith("queued")).map(message => message.steered)).toEqual([undefined, undefined]);
  expect(platform.replies.filter(reply => reply.messageId === "om_queue_1" && reply.text === "飞书隔离测试完成")).toHaveLength(1);
});

it("refuses unpaired or limited callers, impersonation and stale task permissions without changing the transcript", async () => {
  const threadId = await runtime.createConversation("Owned send authorization fixture");
  const path = `/api/bots/${botId}/messages/owned`;
  const prepared = await runtime.prepare(threadId);
  const body = { threadId, sendId: "owned-fixture-receipt-0001", text: "Authorized task request", expectedActiveLeafId: prepared.activeLeafId, expectedApprovalMode: prepared.approvalMode };
  expect((await request("POST", path, body)).status).toBe(403);
  expect((await request("GET", `${path}?threadId=${threadId}`)).status).toBe(403);
  const pairing = await request<{ code: string }>("POST", "/api/auth/pairing", { label: "Limited fixture", scopes: ["client"] });
  const limited = await request<{ token: string }>("POST", "/api/auth/pair", { code: pairing.body.code, label: "Limited fixture" });
  expect((await request("POST", path, body, limited.body.token)).status).toBe(403);
  const token = readFileSync(join(fixture.info.dataDir, "bridge-token"), "utf8").trim();
  expect((await request("POST", path, { ...body, onBehalfOf: { email: "other@example.test" } }, token)).status).toBe(400);
  expect((await request("POST", path, { ...body, expectedApprovalMode: "ask" }, token)).status).toBe(409);
  expect((await request("POST", path, { ...body, expectedActiveLeafId: "stale-leaf" }, token)).status).toBe(409);
  expect((await api<FixturePage>(`/api/threads/${threadId}/messages?limit=100`)).messages).toEqual([]);
  expect((await request("POST", path, body, token)).status).toBe(202);
  await expect.poll(async () => (await runtime.status(threadId, body.sendId)).phase, { timeout: 20_000 }).toBe("completed");
  expect((await request("POST", path, body, token)).status).toBe(202);
  const page = await api<FixturePage>(`/api/threads/${threadId}/messages?limit=100`);
  expect(page.messages.filter((message: { role: string }) => message.role === "user")).toHaveLength(1);
});

it("delivers a complete ten-row Markdown report through the SDK without splitting a row into another message", async () => {
  const header = "| 排名 | 项目 | 今日新增 ⭐ | 中文简介 |\n| --- | --- | --- | --- |";
  const rows = Array.from({ length: 10 }, (_, i) => `| ${i + 1} | [superpowers-${i}](https://github.com/example/project-${i}) | 1,917 | Agent 编程技能框架与软件开发方法，支持工具调用与协作。 |`);
  const report = `数据于 **11 月 18 日（北京时间） ** 查询。\n\n${header}\n${rows.join("\n")}\n\n[查看完整中文报告](https://example.test/report)`;
  expect(report.length).toBeGreaterThan(1_000);
  writeFileSync(join(root, "reply.txt"), report);
  try {
    await platform.emit(raw("om_formatted_report", "获取今日 GitHub Trending", true));
    await settle();
    const replies = platform.replies.filter(reply => reply.messageId === "om_formatted_report" && reply.text.includes(header));
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toBe(report.replace("北京时间） **", "北京时间）**"));
    expect(replies[0]!.requestBytes).toBeLessThan(24_000);
    evidence.push({ action: "complete Markdown table", reply: replies[0] });
  } finally { writeFileSync(join(root, "reply.txt"), "飞书隔离测试完成"); }
});

it("executes a real task tool as the account and still requires workspace approval in Ask mode", async () => {
  const upstream = createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "feishu-fixture" }] }));
      return;
    }
    if (req.method !== "POST") { res.writeHead(404).end(); return; }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text) as { messages: Array<{ role: string }>; tools?: Array<{ function: { name: string; description?: string } }> };
    if (isTitleCall(body)) { res.writeHead(500).end(); return; }
    const name = body.tools?.find(tool => tool.function.description?.includes("isolated Feishu task artifact"))?.function.name;
    const first = !body.messages.some(message => message.role === "tool") &&
      !JSON.stringify(body.messages.findLast(message => message.role === "user")).includes("同意");
    const delta = first ? { tool_calls: [{ index: 0, id: "feishu-write-1", type: "function", function: { name, arguments: "{}" } }] } : { content: "飞书隔离测试完成" };
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Fixture provider address missing");
  try {
    expect((await request("PATCH", "/api/config", { openaiCompat: { key: "synthetic-feishu-key", url: `http://127.0.0.1:${address.port}/v1`, model: "feishu-fixture" } })).status).toBe(200);
    expect((await request("POST", "/api/instances/openaiCompat/refresh-models", {})).status).toBe(200);
    await runControlOmb(["set-model", "--bot", botId, "--instance", "openaiCompat", "--model", "feishu-fixture", "--url", fixture.info.url]);
    const script = join(fixture.info.dataDir, "feishu-write.mjs");
    const artifact = join(fixture.info.dataDir, "feishu-task-result.txt");
    writeFileSync(script, `
  import { createInterface } from 'node:readline';
  import { appendFileSync } from 'node:fs';
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result = request.method === 'initialize' ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'feishutask', version: '1' } }
      : request.method === 'tools/list' ? { tools: [{ name: 'write', description: 'Write the isolated Feishu task artifact', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }
      : request.method === 'tools/call' ? (appendFileSync(process.env.FEISHU_FIXTURE_OUTPUT, 'task executed\\n'), { content: [{ type: 'text', text: 'written' }] }) : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  });
  `);
    expect((await request("POST", "/api/mcp/servers", { name: "feishutask", command: process.execPath, args: [script], env: { FEISHU_FIXTURE_OUTPUT: artifact }, enabled: true })).status).toBe(201);
    expect((await request("PATCH", "/api/mcp/servers/feishutask", { enabled: true })).status).toBe(200);
    expect((await request("PATCH", `/api/bots/${botId}`, { mcpServers: ["feishutask"] })).status).toBe(200);
    await platform.emit(raw("om_task_full", "Write the isolated task artifact", true));
    await settle();
    expect(readFileSync(artifact, "utf8")).toBe("task executed\n");
    expect((await runtime.prepare(state.jobs.at(-1)!.threadId!)).approvalMode).toBe("full");
    expect((await request("PATCH", `/api/bots/${botId}`, { approvalMode: "ask" })).status).toBe(200);
    await platform.emit(raw("om_task_ask", "Write the isolated task artifact after approval", true));
    await expect.poll(async () => { await bridge.tick(); return state.jobs.at(-1)?.phase; }, { timeout: 20_000, interval: 100 }).toBe("waiting");
    const threadId = state.jobs.at(-1)!.threadId!;
    expect((await runtime.prepare(threadId)).approvalMode).toBe("ask");
    expect(readFileSync(artifact, "utf8")).toBe("task executed\n");
    const page = await api<FixturePage>(`/api/threads/${threadId}/messages?limit=100`);
    const card = page.messages.find(message => message.card?.requestId && !message.card.answered)!.card!;
    await platform.emit(raw("om_task_not_approval", "同意", true, "om_task_ask"));
    await bridge.tick();
    expect(state.jobs.at(-1)!.phase).toBe("queued");
    expect(readFileSync(artifact, "utf8")).toBe("task executed\n");
    expect((await request("POST", `/api/threads/${threadId}/respond`, { requestId: card.requestId, behavior: "allow" })).status).toBe(200);
    await settle();
    expect(readFileSync(artifact, "utf8")).toBe("task executed\ntask executed\n");
    expect(platform.replies.some(reply => reply.messageId === "om_task_ask" && reply.text === "飞书隔离测试完成")).toBe(true);
    evidence.push({ action: "owned task tool", artifact, contents: readFileSync(artifact, "utf8"), threadId });
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 60_000);

it("reports a real approval wait and resumes only after a response in the workspace", async () => {
  const wrapper = join(root, "approval-engine.mjs");
  writeFileSync(wrapper, ["#!/usr/bin/env node",
    'process.env.FAKE_CLAUDE_MODE = "hang";',
    `process.env.FAKE_CLAUDE_ELICIT = ${JSON.stringify(JSON.stringify({ mcp_server_name: "fixture", message: "Allow this isolated step?", mode: "form", requested_schema: { type: "object", properties: {} } }))};`,
    `process.env.FAKE_CLAUDE_RELEASE = ${JSON.stringify(join(root, "release"))};`,
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  const patched = await fetch(`${fixture.info.url}/api/instances/claude`, { method: "PATCH", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify({ cli: wrapper }) });
  expect(patched.status).toBe(200);
  const created = await runControlOmb(["new-bot", "--name", "Approval fixture", "--url", fixture.info.url]) as { bot: { id: string } };
  expect((await request("PATCH", `/api/bots/${created.bot.id}`, { approvalMode: "ask" })).status).toBe(200);
  await bridge.close();
  runtime = new OpenMausBotChatRuntime({ url: fixture.info.url, botId: created.bot.id, token: readFileSync(join(fixture.info.dataDir, "bridge-token"), "utf8").trim(), fetch: runtimeFetch });
  state = new ChatState(join(fixture.info.dataDir, "approval-state.json"), "fixture-approval");
  bridge = new ChatBridge({ runtime, delivery: transport, state });
  await platform.emit(raw("om_approval", "approval fixture"));
  await expect.poll(async () => { await bridge.tick(); return state.jobs.at(-1)!.phase; }, { timeout: 15_000, interval: 100 }).toBe("waiting");
  expect(platform.replies.some(reply => reply.messageId === "om_approval" && reply.text.includes("审批"))).toBe(true);
  expect(platform.replies.some(reply => reply.messageId === "om_approval" && reply.text === "飞书隔离测试完成")).toBe(false);
  const threadId = state.jobs.at(-1)!.threadId!;
  const page = await api(`/api/threads/${threadId}/messages?limit=100`) as { messages: { card?: { requestId?: string; answered?: string } }[] };
  const card = page.messages.find(message => message.card?.requestId && !message.card.answered)!.card!;
  const response = await fetch(`${fixture.info.url}/api/threads/${threadId}/respond`, { method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify({ requestId: card.requestId, behavior: "allow" }) });
  expect(response.status).toBe(200);
  evidence.push({ action: "workspace approval", threadId, requestId: card.requestId, status: response.status });
  writeFileSync(join(root, "release"), "finish the isolated turn");
  await settle();
  expect(platform.replies.some(reply => reply.messageId === "om_approval" && reply.text === "released")).toBe(true);
});
