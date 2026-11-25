import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  expect((await call("PUT", { ...configuration, allowedUsers: ["invalid-id"] })).status).toBe(400);
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
it("continues an admitted group topic without mentions, including queued replies and connector restart", async () => {
  const groupMessage = (id: string, text: string, root?: string, mention = false, sender = "ou_alice", chat = "oc_group") => ({
    sender: { sender_type: "user", sender_id: { open_id: sender } }, message: {
      message_id: id, chat_id: chat, chat_type: "group", message_type: "text", content: JSON.stringify({ text }),
      ...(root ? { root_id: root } : {}), ...(mention ? { mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] } : {}),
    },
  });
  const waitForReply = (id: string) => expect.poll(() => fx.platform.replies.some(reply => reply.messageId === id && reply.text === "Feishu fixture answer"),
    { timeout: 20_000, interval: 100 }).toBe(true);
  await fx.platform.emit(groupMessage("om_topic", "@_user_1 Start a topic", undefined, true));
  await fx.platform.emit(groupMessage("om_topic_follow", "Continue without mentioning", "om_topic"));
  await waitForReply("om_topic_follow");
  await waitForReply("om_topic");
  const { bot } = await fx.api("GET", `/api/bots/${configuration.botId}?messages=0`);
  const task = bot.tasks.find((task: { title: string }) => task.title === "feishu group: Start a topic");
  expect(task).toBeDefined();
  expect((await call("PUT", configuration)).status).toBe(200);
  await fx.platform.emit(groupMessage("om_topic_restarted", "Continue after restart", "om_topic"));
  await fx.platform.emit(groupMessage("om_unrelated", "Do not join this topic", "om_other"));
  await fx.platform.emit(groupMessage("om_ordinary", "Do not join ordinary group chat"));
  await fx.platform.emit(groupMessage("om_stranger", "Do not admit this sender", "om_topic", false, "ou_stranger"));
  await fx.platform.emit(groupMessage("om_other_group", "Do not admit this group", "om_topic", false, "ou_alice", "oc_other"));
  await waitForReply("om_topic_restarted");
  const page = await fx.api("GET", `/api/threads/${task.threadId}/messages?limit=100`);
  expect(page.messages.filter((message: { role: string }) => message.role === "user").map((message: { text: string }) => message.text))
    .toEqual(["Start a topic", "Continue without mentioning", "Continue after restart"]);
  const after = await fx.api("GET", `/api/bots/${configuration.botId}?messages=0`);
  expect(after.bot.tasks.filter((task: { title: string }) => task.title.startsWith("feishu group:"))).toHaveLength(1);
  expect(fx.platform.replies.some(reply => ["om_unrelated", "om_ordinary", "om_stranger", "om_other_group"].includes(reply.messageId))).toBe(false);
  expect(fx.platform.replies.filter(reply => reply.messageId.startsWith("om_topic")).every(reply => reply.inThread)).toBe(true);
});
it("sets access independently for two groups while keeping private chats on the saved user list", async () => {
  const everyone = { ...configuration, allowedUsers: [], allowedChats: ["oc_group", "oc_restricted"],
    groupAccessByChat: { oc_group: "everyone", oc_restricted: "allowlist" } };
  const enabled = await call("PUT", everyone);
  expect(enabled.status).toBe(200);
  expect(enabled.body.configuration).toEqual(everyone);
  const emit = (id: string, text: string, sender: string, root?: string, mention = false, group = true, chat = "oc_group") => fx.platform.emit({
    sender: { sender_type: "user", sender_id: { open_id: sender } }, message: {
      message_id: id, chat_id: group ? chat : "oc_direct", chat_type: group ? "group" : "p2p", message_type: "text", content: JSON.stringify({ text }),
      ...(root ? { root_id: root } : {}), ...(mention ? { mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] } : {}),
    },
  });
  const waitForReply = (id: string) => expect.poll(() => fx.platform.replies.some(reply => reply.messageId === id && reply.text === "Feishu fixture answer"),
    { timeout: 20_000, interval: 100 }).toBe(true);
  await emit("om_members", "@_user_1 Everyone topic", "ou_guest", undefined, true);
  await emit("om_members_follow", "Another member continues", "ou_another", "om_members");
  await emit("om_guest_dm", "Do not open a private chat", "ou_guest", undefined, false, false);
  await emit("om_restricted_guest", "@_user_1 Restricted group", "ou_guest", undefined, true, true, "oc_restricted");
  await waitForReply("om_members_follow");
  const listed = { ...configuration, allowedChats: everyone.allowedChats, allowedUsers: ["ou_alice", "ou_bob"],
    groupAccessByChat: { oc_group: "allowlist", oc_restricted: "everyone" } };
  expect((await call("PUT", listed)).body.configuration).toEqual(listed);
  expect((await call("GET")).body.configuration).toEqual(listed);
  await emit("om_members_denied", "Guest cannot continue in allowlist mode", "ou_guest", "om_members");
  await emit("om_bob_dm", "Second allowed private user", "ou_bob", undefined, false, false);
  await emit("om_members_listed", "Listed member continues", "ou_alice", "om_members");
  await emit("om_second_group", "@_user_1 Newly open group", "ou_guest", undefined, true, true, "oc_restricted");
  await waitForReply("om_bob_dm");
  await waitForReply("om_members_listed");
  await waitForReply("om_second_group");
  expect(fx.platform.replies.some(reply => ["om_guest_dm", "om_members_denied", "om_restricted_guest"].includes(reply.messageId))).toBe(false);
  const { bot } = await fx.api("GET", `/api/bots/${configuration.botId}?messages=0`);
  const task = bot.tasks.find((task: { title: string }) => task.title === "feishu group: Everyone topic");
  const page = await fx.api("GET", `/api/threads/${task.threadId}/messages?limit=100`);
  expect(page.messages.filter((message: { role: string }) => message.role === "user").map((message: { text: string }) => message.text))
    .toEqual(["Everyone topic", "Another member continues", "Listed member continues"]);
}, 45_000);
it("persists a home-relative download folder and saves managed files there for manual cleanup", async () => {
  expect((await call("PUT", { ...configuration, downloadDirectory: "relative/folder" })).status).toBe(400);
  const custom = { ...configuration, downloadDirectory: "~/download" };
  expect((await call("PUT", custom)).body.configuration).toEqual(custom);
  expect((await call("GET")).body.configuration?.downloadDirectory).toBe("~/download");
  const content = "managed custom-folder attachment";
  fx.platform.resources.set("om_custom:file_custom", { bytes: Buffer.from(content), mime: "application/octet-stream" });
  await fx.platform.emit({ sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } }, message: {
    message_id: "om_custom", chat_id: "oc_direct", chat_type: "p2p", message_type: "file",
    content: JSON.stringify({ file_key: "file_custom", file_name: "record.mcap" }),
  } });
  await fx.platform.emit({ sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } }, message: {
    message_id: "om_custom_description", chat_id: "oc_direct", chat_type: "p2p", message_type: "text", parent_id: "om_custom",
    content: JSON.stringify({ text: "确认附件可读取。" }),
  } });
  await expect.poll(() => fx.platform.replies.some(reply => reply.messageId === "om_custom" && reply.text === "Feishu fixture answer"),
    { timeout: 20_000, interval: 100 }).toBe(true);
  const folder = join(fx.fixture.info.dataDir, "download");
  const files = readdirSync(folder);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^[0-9a-f-]{36}$/);
  expect(readdirSync(join(folder, files[0]!))).toEqual(["record.mcap"]);
  const path = join(folder, files[0]!, "record.mcap");
  expect(readFileSync(path, "utf8")).toBe(content);
  expect(readFileSync(fx.fixture.fixtureDumpPath, "utf8")).toContain(path);
  expect((await call("PUT", custom)).body.configuration?.downloadDirectory).toBe("~/download");
  unlinkSync(path);
  expect(readdirSync(join(folder, files[0]!))).toEqual([]);
});
it("switches the managed connection through /bot and preserves its choice on reconnect", async () => {
  expect((await call("PUT", configuration)).status).toBe(200);
  const made = await fx.api("POST", "/api/bots", { name: "Managed second bot" });
  const emit = (id: string, text: string) => fx.platform.emit({ sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } }, message: {
    message_id: id, chat_id: "oc_switch", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }),
  } });
  await emit("om_managed_menu", "/bot");
  const [messageId, card] = [...fx.platform.cards].find(([, card]) => card.sourceId === "om_managed_menu")!;
  const menuId = /"menuId":"([a-f0-9]{64})"/.exec(JSON.stringify(card.content))![1]!;
  expect(await fx.platform.click(messageId, "ou_alice", "oc_switch", { action: "select_bot", menuId, botId: made.bot.id })).toMatchObject({ toast: { type: "info" } });
  expect((await call("PUT", configuration)).status).toBe(200);
  await emit("om_managed_selected", "Managed selected bot request");
  await expect.poll(() => fx.platform.replies.some(reply => reply.messageId === "om_managed_selected" && reply.text === "Feishu fixture answer"),
    { timeout: 20_000, interval: 100 }).toBe(true);
  const { bot } = await fx.api("GET", `/api/bots/${made.bot.id}?messages=0`);
  const task = bot.tasks.find((task: { title: string }) => task.title.includes("Managed selected bot request"));
  expect(task).toBeDefined();
  const page = await fx.api("GET", `/api/threads/${task.threadId}/messages?limit=100`);
  expect(page.messages.filter((message: { role: string }) => message.role === "user").map((message: { text: string }) => message.text))
    .toEqual(["Managed selected bot request"]);
});
it("edits without re-entering a secret and disconnects without leaving credentials or a listener", async () => {
  expect((await call("PUT", { ...configuration, allowedChats: [] })).status).toBe(200);
  expect((await call("DELETE")).body).toEqual({ state: "not-connected", saved: false, configuration: null });
  await expect(fx.platform.emit({ sender: { sender_type: "user", sender_id: { open_id: "ou_alice" } }, message: {
    message_id: "om_disconnected", chat_id: "oc_direct", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "Do not dispatch" }),
  } })).rejects.toThrow(/closing/);
  expect(fx.platform.replies.some(reply => reply.messageId === "om_disconnected")).toBe(false);
});
