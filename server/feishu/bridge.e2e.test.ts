import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { basename, dirname, join } from "node:path";
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
  evidence.push({ method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ? "[stream]" : undefined, status: response.status, result: await response.clone().json() });
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
async function emitAttachmentRequest(event: ReturnType<typeof raw>) {
  await platform.emit(event);
  const group = event.message.chat_type === "group";
  const description = raw(`${event.message.message_id}_description`, "请读取附件并完成测试。", group, event.message.root_id ?? event.message.message_id);
  await platform.emit({ ...description, message: { ...description.message, chat_id: event.message.chat_id, parent_id: event.message.message_id } });
}
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
  fixture = await launchVerificationServer({ ...process.env, OMB_FIRST_REPLY_NOTICE_MS: "1000", FAKE_CLAUDE_TOOL_CALLS_FILE: join(root, "calls.json"), FAKE_CLAUDE_REPLY_FILE: join(root, "reply.txt"), FAKE_CLAUDE_RUN_BASH: "1", FAKE_CLAUDE_SHELL_LOG: join(root, "shell.ndjson") });
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
    const message = feishuMessage(event, config, "ou_bot", message => state.hasRoute(message));
    if (message) bridge.accept(message);
  }, input => bridge.control(input));
}, 60_000);

afterAll(async () => {
  transport?.close();
  await bridge?.close();
  if (fixture) {
    const evidencePath = `${fixture.info.logPath}.feishu.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, jobs: state?.jobs, replies: platform?.replies, cards: platform ? [...platform.cards] : [], cardUpdates: platform?.cardUpdates,
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

it("downloads an attachment without inference and combines a later quoted description into the same task after restart", async () => {
  const id = "om_attachment_wait", event = raw(id, ""); event.message.message_type = "file";
  event.message.content = JSON.stringify({ file_key: "file_wait", file_name: "waiting.txt" });
  platform.resources.set(`${id}:file_wait`, { bytes: Buffer.from("pending fixture data"), mime: "text/plain" });
  await platform.emit(event);
  await expect.poll(async () => { await bridge.tick(); return state.jobs.find(job => job.message.id === id)?.phase; }, { timeout: 10_000 }).toBe("awaiting_description");
  const job = state.jobs.find(job => job.message.id === id)!;
  expect(job.threadId).toBeUndefined();
  expect(readFileSync(job.preparedAttachments![0]!.path, "utf8")).toBe("pending fixture data");
  const cardId = job.cardMessageId, downloads = platform.downloads.length;
  expect(platform.cards.get(cardId!)?.content.header).toMatchObject({ title: { content: "等待处理要求" } });
  await bridge.close(); state = new ChatState(join(fixture.info.dataDir, "feishu-state.json"), "fixture");
  bridge = new ChatBridge({ runtime, delivery: transport, state });
  const description = raw("om_attachment_wait_description", "只确认附件能否读取，不要分析内容。");
  const quoted = { ...description, message: { ...description.message, parent_id: id } };
  await platform.emit(quoted); await settle();
  expect(platform.downloads).toHaveLength(downloads);
  const finished = state.jobs.find(item => item.id === job.id)!;
  expect(finished.cardMessageId).toBe(cardId); expect(finished.phase).toBe("completed");
  expect(state.jobs.filter(item => item.message.id === id || item.message.id === description.message.message_id)).toHaveLength(1);
  const page = await api(`/api/threads/${finished.threadId}/messages?limit=100`) as { messages: { role: string; text?: string }[] };
  const user = page.messages.find(message => message.role === "user" && message.text?.startsWith("只确认附件能否读取"))!;
  expect(user.text).toContain("只确认附件能否读取，不要分析内容。");
  expect(user.text).toContain('name="waiting.txt"');
  expect(user.text).not.toContain("attachment-context"); expect(user.text).not.toContain("附件已保存在后端");
  expect(readFileSync(fixture.fixtureDumpPath, "utf8")).toContain("附件已保存在后端");
  const requests = evidence.filter(item => (item as { url?: string }).url?.endsWith("/messages/owned")).length;
  await platform.emit(quoted); await bridge.tick();
  expect(evidence.filter(item => (item as { url?: string }).url?.endsWith("/messages/owned"))).toHaveLength(requests);
  expect(platform.replies.filter(reply => reply.messageId === id)).toHaveLength(1);
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
  expect(state.jobs.find(job => job.message.id === "om_dm_2")!.threadId).toBe(first);
  const groupOne = state.jobs.find(job => job.message.id === "om_group_1")!.threadId;
  const groupTwo = state.jobs.find(job => job.message.id === "om_group_2")!.threadId;
  expect(new Set([first, groupOne, groupTwo]).size).toBe(3);
  await platform.emit(raw("om_group_follow", "topic continuation", true, "om_group_1"));
  await settle();
  expect(state.jobs.at(-1)!.threadId).toBe(groupOne);
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

it("downloads a file into the attachment store, lets the engine read it and deduplicates after restart", async () => {
  const contents = "feishu attachment fixture: 4197\n";
  platform.resources.set("om_file:file_fixture", { bytes: Buffer.from(contents), mime: "application/octet-stream" });
  const reader = join(root, "read-attachment.mjs");
  writeFileSync(reader, `import { readFileSync, writeFileSync } from 'node:fs';
const dump = JSON.parse(readFileSync(${JSON.stringify(fixture.fixtureDumpPath)}, 'utf8'));
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const text = strings(dump.prompt).join('\\n');
const path = /<attached-file path="([^"]+)"/.exec(text)?.[1];
if (!path) throw new Error('No attached file in the engine prompt');
if (!text.includes('附件已保存在后端') || !text.includes('按用户要求')) throw new Error('No attachment reading context in the engine prompt');
writeFileSync(${JSON.stringify(join(root, "bot-read.txt"))}, readFileSync(path));
`);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(root, "calls.json"), JSON.stringify([{ name: "Bash", input: { command: `${quote(process.execPath)} ${quote(reader)}` } }]));
  const file = raw("om_file", "");
  file.message.message_type = "file";
  file.message.content = JSON.stringify({ file_key: "file_fixture", file_name: "fixture report.txt" });
  const defaultRuntime = runtime;
  try {
    await emitAttachmentRequest(file); await settle();
    expect(readFileSync(join(root, "bot-read.txt"), "utf8")).toBe(contents);
    const threadId = state.jobs.at(-1)!.threadId!;
    const page = await api(`/api/threads/${threadId}/messages?limit=100`) as { messages: { role: string; text?: string }[] };
    const attached = page.messages.find(message => message.role === "user" && message.text?.includes('name="fixture report.txt"'))!;
    const path = /<attached-file path="([^"]+)"/.exec(attached.text!)![1]!;
    expect(attached.text).not.toContain("attachment delivery");
    expect(attached.text).not.toContain("附件已保存在后端");
    expect(attached.text).not.toContain("Attachment directory:");
    expect(path.startsWith(join(fixture.info.dataDir, "attachments"))).toBe(true);
    expect(basename(path)).toBe("fixture report.txt");
    expect(basename(dirname(path))).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(path, "utf8")).toBe(contents);
    const downloads = platform.downloads.length;
    await bridge.close();
    state = new ChatState(join(fixture.info.dataDir, "feishu-state.json"), "fixture");
    bridge = new ChatBridge({ runtime, delivery: transport, state });
    await platform.emit(file); await bridge.tick();
    expect(platform.downloads).toHaveLength(downloads);
    expect(platform.replies.filter(reply => reply.messageId === "om_file" && reply.text === "飞书隔离测试完成")).toHaveLength(1);
    await bridge.close();
    runtime = new OpenMausBotChatRuntime({ url: fixture.info.url, botId, token: readFileSync(join(fixture.info.dataDir, "bridge-token"), "utf8").trim(), downloadDirectory: "~/download", fetch: runtimeFetch });
    bridge = new ChatBridge({ runtime, delivery: transport, state });
    platform.resources.set("om_custom_read:file_custom", { bytes: Buffer.from(contents), mime: "application/octet-stream" });
    const custom = raw("om_custom_read", ""); custom.message.message_type = "file";
    custom.message.content = JSON.stringify({ file_key: "file_custom", file_name: "record.mcap" });
    writeFileSync(join(root, "bot-read.txt"), "");
    await emitAttachmentRequest(custom); await settle();
    expect(readFileSync(join(root, "bot-read.txt"), "utf8")).toBe(contents);
    const folder = join(fixture.info.dataDir, "download"), files = readdirSync(folder);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(readdirSync(join(folder, files[0]!))).toEqual(["record.mcap"]);
    unlinkSync(join(folder, files[0]!, "record.mcap")); rmdirSync(join(folder, files[0]!));
    expect(readdirSync(folder)).toEqual([]);
  } finally {
    writeFileSync(join(root, "calls.json"), "[]");
    await bridge.close(); runtime = defaultRuntime;
    bridge = new ChatBridge({ runtime, delivery: transport, state });
  }
});

it("accepts a folder, recursively downloads its files and lets the engine read each original relative path", async () => {
  const expected = { "rosbag/metadata.yaml": "relative_file_paths: [nested/record.mcap]", "rosbag/record.mcap": "root mcap", "rosbag/nested/record.mcap": "fixture mcap", "rosbag/nested/metadata.yaml": "nested metadata", "rosbag/nested/record.done": "", "rosbag/record.done": "" };
  platform.folders.set("om_folder:file_folder", { items: [
    { file_key: "file_folder_meta", name: "metadata.yaml", is_folder: false, size: Buffer.byteLength(expected["rosbag/metadata.yaml"]) },
    { file_key: "file_folder_root_mcap", name: "record.mcap", is_folder: false, size: String(Buffer.byteLength(expected["rosbag/record.mcap"])) },
    { file_key: "file_folder_nested", name: "nested", is_folder: true, size: 999999, children_count: "3", children: [
      { file_key: "file_folder_mcap", name: "record.mcap", is_folder: false, size: Buffer.byteLength(expected["rosbag/nested/record.mcap"]) },
      { file_key: "file_folder_submeta", name: "metadata.yaml", is_folder: false, size: Buffer.byteLength(expected["rosbag/nested/metadata.yaml"]) },
      { file_key: "file_folder_subdone", name: "record.done", is_folder: false },
    ] },
    { file_key: "file_folder_done", name: "record.done", is_folder: false, size: 0 },
    { file_key: "file_folder_empty", name: "empty", is_folder: true, children_count: "0", children: [] },
  ] });
  for (const [key, value] of Object.entries({ file_folder_meta: expected["rosbag/metadata.yaml"], file_folder_root_mcap: expected["rosbag/record.mcap"], file_folder_mcap: expected["rosbag/nested/record.mcap"], file_folder_submeta: expected["rosbag/nested/metadata.yaml"], file_folder_subdone: "", file_folder_done: "" })) {
    platform.resources.set(`om_folder:${key}`, { bytes: Buffer.from(value), mime: "application/octet-stream" });
  }
  const reader = join(root, "read-folder.mjs"), read = join(root, "folder-read.json");
  writeFileSync(reader, `import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const dump = JSON.parse(readFileSync(${JSON.stringify(fixture.fixtureDumpPath)}, 'utf8'));
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const text = strings(dump.prompt).join('\\n');
const files = Object.fromEntries([...text.matchAll(/<attached-file path="([^"]+)" name="([^"]+)"/g)].map(([,path,name]) => [name,readFileSync(path,'utf8')]));
const entries = [...text.matchAll(/<attached-file path="([^"]+)" name="([^"]+)"/g)];
for (const [,path,name] of entries) if (!path.endsWith('/'+name)) throw new Error('Original attachment structure was changed');
const meta = entries.find(([,path,name]) => name === 'rosbag/metadata.yaml')[1];
if(readFileSync(join(dirname(meta),'nested/record.mcap'),'utf8') !== 'fixture mcap') throw new Error('Relative metadata path is broken');
writeFileSync(${JSON.stringify(read)}, JSON.stringify(files));
`);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(root, "calls.json"), JSON.stringify([{ name: "Bash", input: { command: `${quote(process.execPath)} ${quote(reader)}` } }]));
  const event = raw("om_folder", ""); event.message.message_type = "folder";
  event.message.content = JSON.stringify({ file_key: "file_folder", file_name: "rosbag" });
  try {
    await emitAttachmentRequest(event); await settle();
    expect(state.jobs.at(-1)?.phase).toBe("completed");
    expect(JSON.parse(readFileSync(read, "utf8"))).toEqual(expected);
    const named = evidence.findLast(value => (value as { url?: string }).url?.includes("relativePath=rosbag%2Fmetadata.yaml")) as { result: { path: string } };
    const batchRoot = dirname(dirname(named.result.path));
    expect(basename(batchRoot)).toMatch(/^[0-9a-f-]{36}$/);
    expect(readdirSync(batchRoot)).toEqual(["rosbag"]);
    expect(readdirSync(join(batchRoot, "rosbag", "empty"))).toEqual([]);
    expect(platform.cardUpdates.some(update => JSON.stringify(update.content).includes("rosbag/nested/record.mcap"))).toBe(true);
    const total = Object.values(expected).reduce((bytes, value) => bytes + Buffer.byteLength(value), 0);
    const firstProgress = Buffer.byteLength(expected["rosbag/metadata.yaml"]) / total;
    const chartValues = platform.cardUpdates.filter(update => platform.cards.get(update.messageId)?.sourceId === "om_folder")
      .flatMap(update => ((update.content.body as { elements: { chart_spec?: { data: { values: { type: string; value: number }[] } } }[] }).elements)
        .flatMap(element => element.chart_spec?.data.values ?? []));
    expect(chartValues.some(point => point.type === "整体进度" && Math.abs(point.value - firstProgress) < 1e-9)).toBe(true);
    expect(platform.probes.filter(item => item.messageId === "om_folder")).toEqual([{ messageId: "om_folder", key: "file_folder_subdone" }]);
    const downloads = platform.downloads.length, lists = platform.folderRequests.length;
    await bridge.close(); state = new ChatState(join(fixture.info.dataDir, "feishu-state.json"), "fixture");
    bridge = new ChatBridge({ runtime, delivery: transport, state });
    await platform.emit(event); await bridge.tick();
    expect(platform.downloads).toHaveLength(downloads);
    expect(platform.folderRequests).toHaveLength(lists);
    expect(platform.replies.filter(reply => reply.messageId === "om_folder")).toHaveLength(1);
  } finally { writeFileSync(join(root, "calls.json"), "[]"); }
});

it("reports an incomplete folder tree in its card without invoking the engine or downloading files", async () => {
  platform.folders.set("om_folder_partial:file_folder_partial", { all_count: 3, items: [{ file_key: "file_partial", name: "one.mcap", is_folder: false }] });
  const event = raw("om_folder_partial", ""); event.message.message_type = "folder";
  event.message.content = JSON.stringify({ file_key: "file_folder_partial", file_name: "partial" });
  const downloads = platform.downloads.length;
  await emitAttachmentRequest(event); await settle();
  expect(state.jobs.at(-1)).toMatchObject({ phase: "failed", attachmentFailure: "folder" });
  expect(state.jobs.at(-1)?.threadId).toBeUndefined();
  expect(platform.downloads).toHaveLength(downloads);
  expect(platform.cardUpdates.some(update => JSON.stringify(update.content).includes("目录列表不完整"))).toBe(true);
});

it("delivers a downloaded image as native image input and reports download failure without starting a task", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC5kAAAAASUVORK5CYII=", "base64");
  platform.resources.set("om_image:img_fixture", { bytes, mime: "application/octet-stream" });
  const image = raw("om_image", ""); image.message.message_type = "image"; image.message.content = JSON.stringify({ image_key: "img_fixture" });
  await emitAttachmentRequest(image); await settle();
  const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
  expect(JSON.stringify(dump.prompt)).toContain(bytes.toString("base64"));
  const imageSaved = evidence.findLast(value => (value as { url?: string }).url?.includes("image=1")) as { result: { path: string; nativePath: string } };
  expect(basename(imageSaved.result.path)).toBe("image.jpg");
  expect(basename(dirname(imageSaved.result.path))).toMatch(/^[0-9a-f-]{36}$/);
  expect(readFileSync(imageSaved.result.path)).toEqual(bytes);
  expect(imageSaved.result.nativePath).not.toBe(imageSaved.result.path);
  const file = raw("om_forbidden_file", ""); file.message.message_type = "file"; file.message.content = JSON.stringify({ file_key: "file_refused", file_name: "report.pdf" });
  await emitAttachmentRequest(file); await settle();
  expect(state.jobs.at(-1)).toMatchObject({ phase: "failed", attachmentFailure: "download" });
  expect(state.jobs.at(-1)!.threadId).toBeUndefined();
  expect([...platform.cards.values()].some(card => card.sourceId === "om_forbidden_file" && JSON.stringify(card.content).includes("附件下载失败"))).toBe(true);
});

it("saves embedded images together in a custom message directory and preserves native image input", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC5kAAAAASUVORK5CYII=", "base64");
  for (const key of ["img_custom_one", "img_custom_two"]) platform.resources.set(`om_custom_images:${key}`, { bytes, mime: "application/octet-stream" });
  const defaultRuntime = runtime;
  await bridge.close();
  runtime = new OpenMausBotChatRuntime({ url: fixture.info.url, botId, token: readFileSync(join(fixture.info.dataDir, "bridge-token"), "utf8").trim(), downloadDirectory: "~/download", fetch: runtimeFetch });
  bridge = new ChatBridge({ runtime, delivery: transport, state });
  const start = evidence.length;
  const event = raw("om_custom_images", ""); event.message.message_type = "post";
  event.message.content = JSON.stringify({ content: [[{ tag: "img", image_key: "img_custom_one" }, { tag: "img", image_key: "img_custom_two" }]] });
  try {
    await emitAttachmentRequest(event); await settle();
    expect(state.jobs.at(-1)?.phase).toBe("completed");
    const saved = evidence.slice(start).filter(value => (value as { url?: string }).url?.includes("image=1")) as { result: { path: string; nativePath: string } }[];
    expect(saved).toHaveLength(2);
    const batch = dirname(saved[0]!.result.path);
    expect(batch.startsWith(join(fixture.info.dataDir, "download"))).toBe(true);
    expect(dirname(saved[1]!.result.path)).toBe(batch);
    expect(readdirSync(batch).sort()).toEqual(["image-1.jpg", "image-2.jpg"]);
    for (const file of saved) { expect(readFileSync(file.result.path)).toEqual(bytes); expect(readFileSync(file.result.nativePath)).toEqual(bytes); }
    expect(readFileSync(fixture.fixtureDumpPath, "utf8")).toContain(bytes.toString("base64"));
  } finally {
    await bridge.close(); runtime = defaultRuntime;
    bridge = new ChatBridge({ runtime, delivery: transport, state });
  }
});

it("pauses a real CLI download from its card and resumes it after bridge restart before running inference", async () => {
  platform.resources.set("om_cli_pause:file_pause", { bytes: Buffer.alloc(0), size: 34 * 1024 * 1024, mime: "application/octet-stream", rangeChunkDelayMs: 5 });
  const file = raw("om_cli_pause", "", true); file.message.message_type = "file";
  file.message.content = JSON.stringify({ file_key: "file_pause", file_name: "paused.mcap" });
  await emitAttachmentRequest(file);
  const active = bridge.tick();
  await expect.poll(() => platform.downloads.some(download => download.messageId === "om_cli_pause"), { timeout: 5000 }).toBe(true);
  const job = state.jobs.at(-1)!;
  await platform.click(job.cardMessageId!, "ou_alice", "oc_group", { jobId: job.id, action: "pause", revision: job.cardRevision ?? 0 });
  await active;
  expect(job.phase).toBe("paused"); expect(job.threadId).toBeUndefined();
  expect(job.preparedAttachments).toEqual([]);
  await bridge.close();
  state = new ChatState(join(fixture.info.dataDir, "feishu-state.json"), "fixture");
  bridge = new ChatBridge({ runtime, delivery: transport, state });
  const restored = state.jobs.at(-1)!;
  await platform.click(restored.cardMessageId!, "ou_alice", "oc_group", { jobId: restored.id, action: "resume", revision: restored.cardRevision ?? 0 });
  await settle();
  expect(restored.phase).toBe("completed");
  expect(platform.downloads.filter(download => download.messageId === "om_cli_pause" && download.range?.startsWith("bytes=0-"))).toHaveLength(2);
  expect(platform.replies.filter(reply => reply.messageId === "om_cli_pause" && reply.text === "飞书隔离测试完成")).toHaveLength(1);
}, 20_000);

it("saves a 405.4 MiB ranged attachment, proves the engine can read all bytes and reports storage failures", async () => {
  const size = Math.round(405.4 * 1024 * 1024);
  platform.resources.set("om_big:file_big", { bytes: Buffer.alloc(0), mime: "application/octet-stream", size, failRangeOnce: 32 * 1024 * 1024 });
  const reader = join(root, "read-large-attachment.mjs"), receipt = join(root, "large-read.json");
  writeFileSync(reader, `import { readFileSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
const dump = JSON.parse(readFileSync(${JSON.stringify(fixture.fixtureDumpPath)}, 'utf8'));
const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
const text = strings(dump.prompt).join('\\n');
const path = /<attached-file path="([^"]+)" name="big fixture.mcap"/.exec(text)?.[1];
if (!path) throw new Error('No large attachment in the engine prompt');
const hash = createHash('sha256');
for await (const chunk of createReadStream(path)) hash.update(chunk);
writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ path, bytes: statSync(path).size, sha256: hash.digest('hex') }));
`);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(join(root, "calls.json"), JSON.stringify([{ name: "Bash", input: { command: `${quote(process.execPath)} ${quote(reader)}` } }]));
  const file = raw("om_big", "", true);
  file.message.message_type = "file"; file.message.content = JSON.stringify({ file_key: "file_big", file_name: "big fixture.mcap" });
  try {
    await emitAttachmentRequest(file); await settle();
    const read = JSON.parse(readFileSync(receipt, "utf8"));
    expect(read.bytes).toBe(size);
    expect(read.path.startsWith(join(fixture.info.dataDir, "attachments"))).toBe(true);
    const hash = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024, 97);
    for (let offset = 0; offset < size; offset += chunk.length) hash.update(chunk.subarray(0, Math.min(chunk.length, size - offset)));
    expect(read.sha256).toBe(hash.digest("hex"));
    const ranges = platform.downloads.filter(download => download.messageId === "om_big");
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges.every(download => /^bytes=\d+-\d+$/.test(download.range ?? ""))).toBe(true);
    expect(ranges.every(download => { const [start, end] = download.range!.slice(6).split("-").map(Number); return end! - start! + 1 <= 32 * 1024 * 1024; })).toBe(true);
    expect(ranges.filter(download => download.range === `bytes=${32 * 1024 * 1024}-${64 * 1024 * 1024 - 1}`)).toHaveLength(2);
    const cardId = state.jobs.at(-1)!.cardMessageId;
    expect(platform.cardUpdates.some(update => update.messageId === cardId && JSON.stringify(update.content).includes('"value":1'))).toBe(true);
    const count = ranges.length;
    await platform.emit(file); await bridge.tick();
    expect(platform.downloads.filter(download => download.messageId === "om_big")).toHaveLength(count);
    evidence.push({ action: "large attachment read by engine", ...read, ranges: ranges.length });
  } finally { writeFileSync(join(root, "calls.json"), "[]"); }
  for (const [id, size, failure] of [["quota", 128 * 1024 * 1024, "storage"], ["limit", 600 * 1024 * 1024, "size"]] as const) {
    platform.resources.set(`om_${id}:file_${id}`, { bytes: Buffer.alloc(0), mime: "application/octet-stream", size });
    const file = raw(`om_${id}`, "", true); file.message.message_type = "file";
    file.message.content = JSON.stringify({ file_key: `file_${id}`, file_name: `${id}.mcap` });
    await emitAttachmentRequest(file); await settle();
    expect(state.jobs.at(-1)).toMatchObject({ phase: "failed", attachmentFailure: failure });
    expect(state.jobs.at(-1)!.threadId).toBeUndefined();
    expect(readdirSync(join(fixture.info.dataDir, "attachments")).some(name => name.endsWith(".partial"))).toBe(false);
  }
}, 60_000);

it.each([true, false])("shows SDK size-based progress and ETA, or only saved-byte rate when metadata is unavailable (known=%s)", async known => {
  const id = known ? "om_rate_known" : "om_rate_unknown", key = known ? "file_rate_known" : "file_rate_unknown";
  platform.resources.set(`${id}:${key}`, { bytes: Buffer.alloc(0), mime: "application/octet-stream", size: 512 * 1024, rangeChunkDelayMs: 400, ...(known ? {} : { probeStatus: 503 }) });
  const file = raw(id, "", true); file.message.message_type = "file";
  file.message.content = JSON.stringify({ file_key: key, file_name: "rate fixture.mcap" });
  await emitAttachmentRequest(file);
  const active = bridge.tick();
  let progress: { messageId: string; content: Record<string, unknown> } | undefined;
  try {
    await expect.poll(() => {
      const cardId = state.jobs.at(-1)!.cardMessageId;
      progress = platform.cardUpdates.find(update => {
        const text = JSON.stringify(update.content);
        return update.messageId === cardId && /(?:KB|MB)\/s/.test(text) && (known ? text.includes("预计剩余") : text.includes("总大小未知"));
      });
      return Boolean(progress);
    }, { timeout: 12_000, interval: 100 }).toBe(true);
    if (known) {
      const chart = (progress!.content.body as { elements: { chart_spec?: { data: { values: { value: number }[] } } }[] }).elements.find(element => element.chart_spec)?.chart_spec;
      expect(chart?.data.values[0]?.value).toBeGreaterThan(0); expect(chart?.data.values[0]?.value).toBeLessThan(1);
    } else {
      expect(JSON.stringify(progress!.content)).not.toContain("预计剩余");
      expect(JSON.stringify(progress!.content)).not.toContain("linearProgress");
    }
  } finally { await active; }
  await settle();
  expect(state.jobs.at(-1)!.phase).toBe("completed");
}, 25_000);

it("refuses unpaired or limited callers, impersonation and stale task permissions without changing the transcript", async () => {
  const threadId = await runtime.createConversation("Owned send authorization fixture");
  const path = `/api/bots/${botId}/messages/owned`;
  const prepared = await runtime.prepare(threadId);
  const body = { threadId, sendId: "owned-fixture-receipt-0001", text: "Authorized task request", expectedActiveLeafId: prepared.activeLeafId, expectedApprovalMode: prepared.approvalMode };
  expect((await request("POST", path, body)).status).toBe(403);
  expect((await request("GET", `${path}?threadId=${threadId}`)).status).toBe(403);
  const pairing = await request<{ code: string }>("POST", "/api/auth/pairing", { label: "Limited fixture", scopes: ["client"] });
  const limited = await request<{ token: string }>("POST", "/api/auth/pair", { code: pairing.body.code, label: "Limited fixture" });
  expect((await request("GET", "/api/feishu/files")).status).toBe(403);
  expect((await request("GET", "/api/feishu/files", undefined, limited.body.token)).status).toBe(403);
  expect((await request("POST", path, body, limited.body.token)).status).toBe(403);
  const token = readFileSync(join(fixture.info.dataDir, "bridge-token"), "utf8").trim();
  expect((await request("GET", "/api/feishu/files", undefined, token)).status).toBe(200);
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

it("distinguishes CLI permission, integrity and network failures and cleans incomplete file saves", async () => {
  for (const [id, options, failure] of [
    ["permission", { status: 403 }, "permission"],
    ["range", { corruptRangeAt: 0 }, "range"],
    ["integrity", { shiftRangeAt: 0 }, "integrity"],
    ["network", { failRange: 0 }, "network"],
  ] as const) {
    platform.resources.set(`om_failed_${id}:file_${id}`, { bytes: Buffer.from("abc"), mime: "text/plain", ...options });
    const file = raw(`om_failed_${id}`, "", true); file.message.message_type = "file";
    file.message.content = JSON.stringify({ file_key: `file_${id}`, file_name: `${id}.txt` });
    await emitAttachmentRequest(file); await settle();
    expect(state.jobs.at(-1)).toMatchObject({ phase: "failed", attachmentFailure: failure });
    expect(state.jobs.at(-1)!.threadId).toBeUndefined();
    expect(readdirSync(join(fixture.info.dataDir, "attachments")).some(name => name.endsWith(".partial"))).toBe(false);
  }
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
  expect([...platform.cards.values()].some(card => card.sourceId === "om_approval" && JSON.stringify(card.content).includes("审批"))).toBe(true);
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

it("updates one task card and safely pauses, continues and stops a real isolated execution through SDK callbacks", async () => {
  const wrapper = join(root, "controls-engine.mjs"), release = join(root, "controls-release");
  writeFileSync(wrapper, ["#!/usr/bin/env node", 'process.env.FAKE_CLAUDE_MODE = "hang";',
    `process.env.FAKE_CLAUDE_RELEASE = ${JSON.stringify(release)};`,
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  expect((await request("PATCH", "/api/instances/claude", { cli: wrapper })).status).toBe(200);
  const created = await runControlOmb(["new-bot", "--name", "Task controls fixture", "--url", fixture.info.url]) as { bot: { id: string } };
  await bridge.close();
  runtime = new OpenMausBotChatRuntime({ url: fixture.info.url, botId: created.bot.id, token: readFileSync(join(fixture.info.dataDir, "bridge-token"), "utf8").trim(), fetch: runtimeFetch });
  const statePath = join(fixture.info.dataDir, "controls-state.json");
  state = new ChatState(statePath, "fixture-controls");
  bridge = new ChatBridge({ runtime, delivery: transport, state });
  await platform.emit(raw("om_controls", "Card controls fixture request", true));
  await expect.poll(async () => { await bridge.tick(); return state.jobs[0]?.phase; }, { timeout: 15_000, interval: 100 }).toBe("working");
  const job = state.jobs[0]!, threadId = job.threadId!, cardId = job.cardMessageId!;
  expect(platform.cards.get(cardId)?.sourceId).toBe("om_controls");
  expect(platform.cardUpdates.some(update => update.messageId === cardId && JSON.stringify(update.content).includes("正在处理"))).toBe(true);
  const click = (action: string, revision: number, sender = "ou_alice") => platform.click(cardId, sender, "oc_group", { jobId: job.id, action, revision });
  expect(await click("stop", 0, "ou_other")).toMatchObject({ toast: { type: "error" } });
  expect(await click("pause", 0)).toMatchObject({ toast: { type: "info" } });
  await bridge.tick();
  expect(job.phase).toBe("paused");
  expect((await runtime.status(threadId, job.id)).phase).toBe("stopped");
  await bridge.close();
  state = new ChatState(statePath, "fixture-controls");
  bridge = new ChatBridge({ runtime, delivery: transport, state });
  expect(await click("resume", 1)).toMatchObject({ toast: { type: "info" } });
  await bridge.tick();
  expect(state.jobs[0]!.phase).toBe("working");
  const send = evidence.findLast(item => (item as { method?: string; url?: string }).method === "POST" && (item as { url?: string }).url?.endsWith("/messages/owned")) as { body: { sendId: string; text: string } };
  expect(send.body.sendId).not.toBe(job.id);
  expect(send.body.text).toContain("继续完成此前暂停的请求");
  expect(await click("stop", 2)).toMatchObject({ toast: { type: "info" } });
  await bridge.tick();
  expect(state.jobs[0]!.phase).toBe("stopped");
  expect((await runtime.status(threadId, send.body.sendId)).phase).toBe("stopped");
  expect(await click("resume", 1)).toMatchObject({ toast: { type: "error" } });
  expect([...platform.cards.values()].filter(card => card.sourceId === "om_controls")).toHaveLength(1);
  expect(JSON.stringify(platform.cards.get(cardId)?.content)).toContain("已结束");
  writeFileSync(release, "finish the isolated followup");
  await platform.emit(raw("om_controls_followup", "Run after a stopped task", true, "om_controls"));
  await settle();
  expect(state.jobs.at(-1)!.threadId).toBe(threadId);
  expect(platform.replies.some(reply => reply.messageId === "om_controls_followup" && reply.text === "released")).toBe(true);
}, 40_000);

it("keeps a slow first reply tracked through its rescue notice and delivers the final answer", async () => {
  const wrapper = join(root, "slow-reply-engine.mjs"), release = join(root, "slow-reply-release");
  writeFileSync(wrapper, ["#!/usr/bin/env node", 'process.env.FAKE_CLAUDE_MODE = "hang";',
    `process.env.FAKE_CLAUDE_RELEASE = ${JSON.stringify(release)};`,
    `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
  ].join("\n"), { mode: 0o700 });
  expect((await request("PATCH", "/api/instances/claude", { cli: wrapper })).status).toBe(200);
  const created = await runControlOmb(["new-bot", "--name", "Slow first reply fixture", "--url", fixture.info.url]) as { bot: { id: string } };
  await bridge.close();
  runtime = new OpenMausBotChatRuntime({ url: fixture.info.url, botId: created.bot.id, token: readFileSync(join(fixture.info.dataDir, "bridge-token"), "utf8").trim(), fetch: runtimeFetch });
  state = new ChatState(join(fixture.info.dataDir, "slow-state.json"), "fixture-slow");
  bridge = new ChatBridge({ runtime, delivery: transport, state });
  await platform.emit(raw("om_slow", "Wait for this slow reply", true));
  await bridge.tick();
  const job = state.jobs[0]!;
  await expect.poll(async () => {
    const page = await api<{ messages: { tool?: { rescue?: unknown }; requestMessageId?: string }[] }>(`/api/threads/${job.threadId}/messages?limit=100`);
    return page.messages.some(message => message.tool?.rescue);
  }, { timeout: 10_000, interval: 100 }).toBe(true);
  await bridge.tick();
  expect(job.phase).toBe("working");
  writeFileSync(release, "finish the isolated slow turn");
  await settle();
  expect(job.phase).toBe("completed");
  expect(platform.replies.filter(reply => reply.messageId === "om_slow" && reply.text === "released")).toHaveLength(1);
});
