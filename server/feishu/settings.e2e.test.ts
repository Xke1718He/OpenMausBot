import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FEISHU_FIXTURE_SECRET, launchFeishuFixture } from "../../scripts/testing/feishu-fixture.ts";
import type { FeishuConnectionStatus } from "../../shared/feishu.ts";

let fx: Awaited<ReturnType<typeof launchFeishuFixture>>;
let server: Server;
let base: string;
const evidence: unknown[] = [];
const configuration = { appId: "cli_0123456789abcdef", botId: "", domain: "feishu", allowedUsers: ["ou_alice"], allowedChats: ["oc_group"] };
const call = async (method: string, body?: unknown, admin = true) => {
  const response = await fetch(base, { method, headers: { "content-type": "application/json", "x-test-admin": String(admin) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json() as FeishuConnectionStatus;
  evidence.push({ method, status: response.status, value });
  return { status: response.status, body: value };
};
beforeAll(async () => {
  fx = await launchFeishuFixture();
  const made = await fx.api("POST", "/api/bots", { name: "Feishu settings fixture" }); configuration.botId = made.bot.id;
  server = createServer((req, res) => { void fx.route(req, res, req.headers["x-test-admin"] !== "false"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/feishu`;
}, 30_000);
afterAll(async () => {
  if (fx) {
    writeFileSync(`${fx.fixture.info.logPath}.feishu-settings.json`, JSON.stringify({ fixture: fx.fixture.info, evidence, replies: fx.platform.replies, limitation: "Isolated runtime, synthetic credentials and SDK event dispatcher. No live Feishu account." }, null, 2));
  }
  await fx?.close();
  await new Promise<void>(resolve => server?.close(() => resolve()));
});

it("exposes the production settings endpoint and refuses non-admin connections", async () => {
  expect(await fx.api("GET", "/api/feishu")).toEqual({ state: "not-connected", saved: false, configuration: null });
  expect((await call("GET", undefined, false)).status).toBe(403);
  expect((await call("PUT", { ...configuration, appSecret: FEISHU_FIXTURE_SECRET }, false)).status).toBe(403);
  expect((await call("PUT", { ...configuration, allowedUsers: [] })).status).toBe(400);
});
it("refuses bad credentials, connects with sealed credentials, then receives and answers a real isolated turn", async () => {
  expect((await call("PUT", { ...configuration, appSecret: "bad-secret" })).status).toBe(502);
  expect((await call("GET")).body.saved).toBe(false);
  const connected = await call("PUT", { ...configuration, appSecret: FEISHU_FIXTURE_SECRET });
  expect(connected.status).toBe(200);
  expect(connected.body).toEqual({ state: "connected", saved: true, configuration });
  expect(JSON.stringify(connected.body)).not.toContain(FEISHU_FIXTURE_SECRET);
  expect(readFileSync(fx.statePath).includes(Buffer.from(FEISHU_FIXTURE_SECRET))).toBe(false);
  await fx.platform.emit({ sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } }, message: {
    message_id: "om_settings", chat_id: "oc_direct", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "Managed fixture request" }),
  } });
  await expect.poll(() => fx.platform.replies.some(reply => reply.messageId === "om_settings" && reply.text === "Feishu fixture answer"), { timeout: 20_000, interval: 100 }).toBe(true);
  const { bot } = await fx.api("GET", `/api/bots/${configuration.botId}?messages=0`);
  const task = bot.tasks.find((task: { title: string }) => task.title.startsWith("feishu DM:"));
  expect(task.approvalMode).toBe("full");
  const page = await fx.api("GET", `/api/threads/${task.threadId}/messages?limit=100`);
  const line = page.messages.find((message: { role: string }) => message.role === "user");
  expect(line).toMatchObject({ text: "Managed fixture request", sender: { id: expect.stringMatching(/^p_/) } });
  expect(line.relayed).toBeUndefined();
});
it("edits without re-entering a secret and disconnects without leaving credentials or a listener", async () => {
  expect((await call("PUT", { ...configuration, allowedChats: [] })).status).toBe(200);
  expect((await call("DELETE")).body).toEqual({ state: "not-connected", saved: false, configuration: null });
  await expect(fx.platform.emit({ sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } }, message: {
    message_id: "om_disconnected", chat_id: "oc_direct", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "Do not dispatch" }),
  } })).rejects.toThrow(/closing/);
  expect(fx.platform.replies.some(reply => reply.messageId === "om_disconnected")).toBe(false);
});
