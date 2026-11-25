import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../../scripts/control-omb.ts";
import { OpenMausBotChatRuntime } from "../messaging/openmausbot.ts";
import { ChatState } from "../messaging/state.ts";
import { FakeFeishu } from "../testing/fake-feishu.ts";
import { FeishuBotRouter } from "./bot-router.ts";
import { feishuConfigSchema } from "./config.ts";
import { feishuMessage } from "./events.ts";
import { feishuMessageAllowed } from "./access.ts";
import type { FeishuTransport } from "./transport.ts";

let fixture: VerificationServer;
let platform: FakeFeishu;
let transport: FeishuTransport;
let runtime: OpenMausBotChatRuntime;
let router: FeishuBotRouter;
let main = "", other = "", statePath = "";
let revoked = false;
const evidence: { method: string; url: string; body?: Record<string, unknown> }[] = [];
const config = feishuConfigSchema.parse({ appId: "cli_0123456789abcdef", botId: "placeholder", url: "http://127.0.0.1:8799", allowedUsers: ["ou_alice", "ou_bob"], allowedChats: ["oc_group"], groupAccessByChat: { oc_group: "everyone" } });
function raw(id: string, text: string, sender = "ou_alice", root?: string, mention = true) {
  return {
    sender: { sender_type: "user", sender_id: { open_id: sender } }, message: {
      message_id: id, chat_id: root ? "oc_group" : `oc_${sender}`, chat_type: root ? "group" : "p2p", message_type: "text",
      content: JSON.stringify({ text }), ...(root ? { root_id: root, ...(mention ? { mentions: [{ key: "@bot", id: { open_id: "ou_bot" } }] } : {}) } : {}),
    },
  };
}
function startRouter() {
  return new FeishuBotRouter({ runtime, transport, statePath, scope: "bot-router-fixture", defaultBotId: main, allowed: message => !revoked && feishuMessageAllowed(message, config) });
}
async function menu(id: string, sender = "ou_alice", root?: string) {
  await platform.emit(raw(id, "/bot", sender, root));
  const [messageId, card] = [...platform.cards].find(([, card]) => card.sourceId === id)!;
  const content = JSON.stringify(card.content);
  const menuId = /"menuId":"([a-f0-9]{64})"/.exec(content)![1]!;
  return { messageId, menuId, value: { action: "select_bot", menuId, botId: other } };
}
async function choose(id: string, botId: string, sender = "ou_alice", root?: string) {
  const card = await menu(id, sender, root);
  const result = await platform.click(card.messageId, sender, root ? "oc_group" : `oc_${sender}`, { ...card.value, botId });
  expect(result).toMatchObject({ toast: { type: "info" }, card: { type: "raw" } });
  return card;
}
async function settle(messageIds: string[]) {
  await expect.poll(async () => {
    await router.tick();
    return messageIds.every(id => platform.replies.some(reply => reply.messageId === id && reply.text === "Bot selection fixture reply"));
  }, { timeout: 30_000, interval: 100 }).toBe(true);
}
const sent = () => evidence.filter(item => item.method === "POST" && item.url.endsWith("/messages/owned"));
const botSends = (botId: string) => sent().filter(item => item.url.includes(`/bots/${botId}/`));

beforeAll(async () => {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_REPLIES: JSON.stringify(Array<string>(20).fill("Bot selection fixture reply")) });
  main = ((await runControlOmb(["new-bot", "--name", "Default fixture", "--url", fixture.info.url])) as { bot: { id: string } }).bot.id;
  other = ((await runControlOmb(["new-bot", "--name", "Direct fixture", "--url", fixture.info.url])) as { bot: { id: string } }).bot.id;
  for (const [botId, profile] of [
    [main, { title: "项目协调", description: "拆分任务，跟进项目进度。" }],
    [other, { title: "软件开发", description: "编写代码、审查变更并验证结果。", soul: "private-fixture-instructions" }],
  ] as const) {
    const response = await fetch(`${fixture.info.url}/api/bots/${botId}`, { method: "PATCH", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify(profile) });
    expect(response.status).toBe(200);
  }
  const tokenPath = join(fixture.info.dataDir, "bridge-token");
  await runControlOmb(["connect", fixture.info.url, "--out", tokenPath]);
  runtime = new OpenMausBotChatRuntime({ url: fixture.info.url, botId: main, token: readFileSync(tokenPath, "utf8").trim(), fetch: async (url, init) => {
    evidence.push({ method: init?.method ?? "GET", url: String(url), ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) });
    return fetch(url, init);
  } });
  await runtime.connect();
  platform = new FakeFeishu(); await platform.listen(); transport = platform.transport(config);
  statePath = join(fixture.info.dataDir, "feishu-routing.state.json");
  const legacy = new ChatState(statePath, "bot-router-fixture");
  legacy.enqueue(feishuMessage(raw("om_legacy", "Default request before switching"), config, "ou_bot")!);
  router = startRouter();
  await transport.start(async event => {
    const message = feishuMessage(event, config, "ou_bot", message => router.hasRoute(message));
    if (message) await router.accept(message);
  }, input => router.control(input), input => router.select(input));
}, 60_000);

afterAll(async () => {
  vi.restoreAllMocks();
  transport?.close(); await router?.close();
  if (fixture) {
    const evidencePath = `${fixture.info.logPath}.bot-routing.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, cards: platform ? [...platform.cards] : [], replies: platform?.replies,
      limitation: "Isolated fake engine and Feishu API; no live WebSocket connection or Feishu client rendering." }, null, 2));
    console.info(JSON.stringify({ evidencePath }));
  }
  await platform?.close(); await fixture?.close();
});

it("shows public responsibilities from the workspace and retains them in restored menus", async () => {
  const card = await menu("om_profile_menu");
  const content = JSON.stringify(platform.cards.get(card.messageId)!.content);
  expect(content).toContain("项目协调");
  expect(content).toContain("拆分任务，跟进项目进度。");
  expect(content).toContain("软件开发");
  expect(content).toContain("编写代码、审查变更并验证结果。");
  expect(content).not.toContain("private-fixture-instructions");
  await router.close(); router = startRouter();
  const restored = await platform.click(card.messageId, "ou_alice", "oc_ou_alice", { action: "bot_page", menuId: card.menuId, page: 0 });
  expect(restored).toMatchObject({ toast: { type: "info" } });
  expect(JSON.stringify(restored)).toContain("编写代码、审查变更并验证结果。");
});

it("selects a bot without inference, pins existing work to the original bot, and refuses forged callbacks", async () => {
  const before = evidence.filter(item => item.method === "POST").length;
  const card = await menu("om_menu_initial");
  expect(evidence.filter(item => item.method === "POST")).toHaveLength(before);
  for (const [messageId, sender, chat, value] of [
    [card.messageId, "ou_bob", "oc_ou_alice", card.value],
    [card.messageId, "ou_alice", "oc_wrong", card.value],
    ["om_wrong", "ou_alice", "oc_ou_alice", card.value],
    [card.messageId, "ou_alice", "oc_ou_alice", { ...card.value, botId: "forged" }],
  ] as const) expect(await platform.click(messageId, sender, chat, value)).toMatchObject({ toast: { type: "error" } });
  const selected = await platform.click(card.messageId, "ou_alice", "oc_ou_alice", card.value);
  expect(selected).toMatchObject({ toast: { type: "info" } });
  expect(JSON.stringify(selected)).toContain("编写代码、审查变更并验证结果。");
  await platform.emit(raw("om_other", "Direct request to selected bot"));
  await settle(["om_legacy", "om_other"]);
  expect(botSends(main).map(item => item.body?.text)).toEqual(["Default request before switching"]);
  expect(botSends(other).map(item => item.body?.text)).toEqual(["Direct request to selected bot"]);
  expect(platform.replies.some(reply => reply.messageId === "om_other" && reply.text === "Bot selection fixture reply")).toBe(true);
}, 40_000);

it("restores the selection after restart, deduplicates across switches and resumes each bot's own conversation", async () => {
  const firstThread = botSends(main)[0]!.body!.threadId;
  const otherThread = botSends(other)[0]!.body!.threadId;
  await router.close(); router = startRouter();
  await platform.emit(raw("om_other_resume", "Selected bot after restart")); await settle(["om_other_resume"]);
  expect(botSends(other).at(-1)?.body?.threadId).toBe(otherThread);
  await choose("om_switch_back", main);
  await platform.emit(raw("om_main_resume", "Resume default conversation"));
  await platform.emit(raw("om_other", "Duplicate delivered after switching"));
  await settle(["om_main_resume"]);
  expect(botSends(main).at(-1)?.body?.threadId).toBe(firstThread);
  expect(sent().filter(item => item.body?.text === "Duplicate delivered after switching")).toHaveLength(0);
  await choose("om_switch_again", other);
  await platform.emit(raw("om_other_again", "Resume second conversation")); await settle(["om_other_again"]);
  expect(botSends(other).at(-1)?.body?.threadId).toBe(otherThread);
}, 40_000);

it("keeps group choices within the sender and topic and accepts unmentioned topic continuation", async () => {
  await choose("om_group_menu", other, "ou_alice", "om_topic");
  await platform.emit(raw("om_group_selected", "Alice selected in topic", "ou_alice", "om_topic", false));
  await platform.emit(raw("om_group_bob", "Bob default in same topic", "ou_bob", "om_topic", false));
  await platform.emit(raw("om_group_new_topic", "Alice default in another topic", "ou_alice", "om_another_topic"));
  await settle(["om_group_selected", "om_group_bob", "om_group_new_topic"]);
  expect(botSends(other).some(item => item.body?.text === "Alice selected in topic")).toBe(true);
  expect(botSends(main).some(item => item.body?.text === "Bob default in same topic")).toBe(true);
  expect(botSends(main).some(item => item.body?.text === "Alice default in another topic")).toBe(true);
}, 40_000);

it("paginates a large catalog and rejects stale, repeated, revoked and unavailable choices", async () => {
  const bots = await runtime.listBots();
  const catalog = [...bots, ...Array.from({ length: 20 }, (_, i) => ({ id: `extra_${i}`, name: `Extra <${i}>`,
    title: i === 0 ? "" : `Extra role ${i}`, description: i === 0 ? "  " : `Extra responsibility ${i} ${"职责😀".repeat(1000)}`,
  }))];
  const listing = vi.spyOn(runtime, "listBots").mockResolvedValue(catalog);
  const old = await menu("om_old_menu");
  const latest = await menu("om_latest_menu");
  const latestContent = JSON.stringify(platform.cards.get(latest.messageId)!.content);
  expect(latestContent).toContain("尚未填写职责介绍");
  expect(Buffer.byteLength(latestContent)).toBeLessThan(30_000);
  const cardCount = platform.cards.size;
  await platform.emit(raw("om_latest_menu", "/bot"));
  expect(platform.cards.size).toBe(cardCount);
  expect(await platform.click(old.messageId, "ou_alice", "oc_ou_alice", old.value)).toMatchObject({ toast: { type: "error" } });
  const paged = await platform.click(latest.messageId, "ou_alice", "oc_ou_alice", { action: "bot_page", menuId: latest.menuId, page: 1 });
  expect(paged).toMatchObject({ toast: { type: "info" } });
  expect(JSON.stringify(paged)).toContain("Extra <");
  expect(JSON.stringify(paged)).toContain("Extra responsibility");
  expect(JSON.stringify(paged)).toContain("…");
  expect(JSON.stringify(paged)).not.toContain("职责😀".repeat(1000));
  expect(await platform.click(latest.messageId, "ou_alice", "oc_ou_alice", { action: "bot_page", menuId: latest.menuId, page: 900 })).toMatchObject({ toast: { type: "error" } });
  listing.mockResolvedValue(bots.filter(bot => bot.id !== other));
  expect(await platform.click(latest.messageId, "ou_alice", "oc_ou_alice", latest.value)).toMatchObject({ toast: { type: "error" } });
  listing.mockResolvedValue(bots);
  revoked = true;
  expect(await platform.click(latest.messageId, "ou_alice", "oc_ou_alice", latest.value)).toMatchObject({ toast: { type: "error" } });
  revoked = false;
  expect(await platform.click(latest.messageId, "ou_alice", "oc_ou_alice", latest.value)).toMatchObject({ toast: { type: "info" } });
  expect(await platform.click(latest.messageId, "ou_alice", "oc_ou_alice", latest.value)).toMatchObject({ toast: { type: "error" } });
  const expired = await menu("om_expired_menu");
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 25 * 3_600_000);
  try { expect(await platform.click(expired.messageId, "ou_alice", "oc_ou_alice", expired.value)).toMatchObject({ toast: { type: "error" } }); }
  finally { clock.mockRestore(); }
  listing.mockRestore();
});
