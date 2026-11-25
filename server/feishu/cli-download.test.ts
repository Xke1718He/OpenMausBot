import { readdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeFeishu } from "../testing/fake-feishu.ts";
import { FeishuCliDownloader } from "./cli-download.ts";
import { feishuConfigSchema } from "./config.ts";

let platform: FakeFeishu;
let downloader: FeishuCliDownloader;
let transport: ReturnType<FakeFeishu["transport"]>;
const config = feishuConfigSchema.parse({ appId: "cli_0123456789abcdef", botId: "fixture", url: "http://127.0.0.1:8799", allowedUsers: ["ou_fixture"] });
const message = { platform: "feishu", account: config.appId, id: "om_cli_resource", chatId: "oc_fixture", senderId: "ou_fixture", kind: "direct" as const, text: "Read the file" };
const attachment = { kind: "file" as const, key: "file_fixture", name: "report.pdf" };
beforeAll(async () => {
  platform = new FakeFeishu(); await platform.listen();
  transport = platform.transport(config);
  downloader = new FeishuCliDownloader(config, async () => "fake-tenant", platform.cli.options);
});
afterAll(async () => { downloader?.close(); transport?.close(); await platform?.close(); });

it("loads recursive folder sizes through the SDK using the configured bot identity", async () => {
  platform.folders.set("om_cli_resource:file_folder", { items: [
    { file_key: "file_meta", name: "metadata.yaml", is_folder: false, size: "12" },
    { file_key: "file_nested", name: "nested", is_folder: true, size: 101, children_count: "1", children: [{ file_key: "file_mcap", name: "record.mcap", is_folder: false, size: 101 }] },
  ] });
  expect(await transport.expand({ ...message, attachments: [{ kind: "folder", key: "file_folder", name: "rosbag" }] }, new AbortController().signal)).toEqual({ attachments: [
    { kind: "file", key: "file_meta", name: "metadata.yaml", sourcePath: "rosbag/metadata.yaml", bytes: 12 },
    { kind: "file", key: "file_mcap", name: "record.mcap", sourcePath: "rosbag/nested/record.mcap", bytes: 101 },
  ], directories: ["rosbag", "rosbag/nested"] });
  expect(platform.folderRequests).toContainEqual({ messageId: message.id, key: "file_folder" });
  expect(platform.probes).toHaveLength(0);
});

it("preserves folder-list permission failures instead of returning an empty manifest", async () => {
  platform.folders.set("om_cli_resource:file_denied_folder", { items: [], status: 403 });
  await expect(transport.expand({ ...message, attachments: [{ kind: "folder", key: "file_denied_folder", name: "private" }] }, new AbortController().signal)).rejects.toMatchObject({ attachmentFailure: "permission" });
});

it("confirms a zero-byte folder marker with a complete CLI download after Feishu's empty partial response", async () => {
  platform.resources.set("om_cli_resource:file_empty", { bytes: Buffer.alloc(0), mime: "application/octet-stream" });
  const resource = await downloader.download(message, { kind: "file", key: "file_empty", name: "record.done" });
  try {
    expect(await resource.prepare!(1024)).toMatchObject({ bytes: 0 });
    expect(Buffer.concat(await resource.stream.toArray())).toHaveLength(0);
    expect(platform.downloads.filter(item => item.key === "file_empty").map(item => item.range)).toEqual([expect.stringMatching(/^bytes=0-\d+$/), undefined]);
  } finally { await resource.cancel!(); }
});

it("rejects nonempty complete content after a contradictory empty range response", async () => {
  platform.resources.set("om_cli_resource:file_false_empty", { bytes: Buffer.from("not empty"), mime: "application/octet-stream", emptyRange: true });
  const resource = await downloader.download(message, { kind: "file", key: "file_false_empty", name: "record.mcap" });
  try { await expect(resource.prepare!(1024)).rejects.toMatchObject({ attachmentFailure: "integrity" }); }
  finally { await resource.cancel!(); }
  expect(platform.downloads.filter(item => item.key === "file_false_empty").map(item => item.range)).toEqual([expect.stringMatching(/^bytes=0-\d+$/), undefined]);
});

it("runs the installed CLI with the connection's bot identity and reads the saved bytes", async () => {
  platform.resources.set("om_cli_resource:file_fixture", { bytes: Buffer.from("%PDF-fixture"), mime: "application/pdf", ignoreRange: true });
  const resource = await downloader.download(message, attachment);
  try {
    expect(await resource.prepare!(1024)).toEqual({ mime: "application/pdf", bytes: 12 });
    expect(Buffer.concat(await resource.stream.toArray()).toString()).toBe("%PDF-fixture");
    expect(platform.cli.requests.some(request => request.path.includes("/messages/om_cli_resource/resources/file_fixture"))).toBe(true);
  } finally { await resource.cancel!(); }
});

it("uses the CLI for images and identifies their actual type before saving", async () => {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC5kAAAAASUVORK5CYII=", "base64");
  platform.resources.set("om_cli_resource:img_fixture", { bytes, mime: "application/octet-stream" });
  const resource = await downloader.download(message, { kind: "image", key: "img_fixture", name: "image.jpg" });
  try {
    expect(await resource.prepare!(10 * 1024 * 1024)).toEqual({ mime: "image/png", bytes: bytes.length });
    expect(Buffer.concat(await resource.stream.toArray())).toEqual(bytes);
  } finally { await resource.cancel!(); }
});

it("exposes SDK-probed total bytes before a real CLI transfer finishes", async () => {
  const bytes = 34 * 1024 * 1024;
  platform.resources.set("om_cli_resource:file_sdk_progress", { bytes: Buffer.alloc(0), size: bytes, mime: "application/octet-stream", rangeChunkDelayMs: 10 });
  const resource = await transport.download(message, { kind: "file", key: "file_sdk_progress", name: "data.mcap" });
  const preparing = resource.prepare!(512 * 1024 * 1024); void preparing.catch(() => undefined);
  try {
    await expect.poll(() => resource.progress?.().received ?? 0, { timeout: 5000 }).toBeGreaterThan(256 * 1024);
    expect(resource.progress?.().total).toBe(bytes);
    expect(platform.probes).toContainEqual({ messageId: message.id, key: "file_sdk_progress" });
    await resource.cancel!(); await expect(preparing).rejects.toMatchObject({ attachmentFailure: "download" });
  } finally { await resource.cancel!(); }
});

it("rejects a saved file inconsistent with metadata and refuses known oversize files before payload transfer", async () => {
  platform.resources.set("om_cli_resource:file_wrong_size", { bytes: Buffer.from("actual"), mime: "text/plain" });
  const resource = await transport.download(message, { kind: "file", key: "file_wrong_size", name: "data.txt", bytes: 100 });
  try { await expect(resource.prepare!(1024)).rejects.toMatchObject({ attachmentFailure: "integrity" }); }
  finally { await resource.cancel!(); }
  const oversized = await transport.download(message, { kind: "file", key: "file_known_big", name: "data.txt", bytes: 2048 });
  try { await expect(oversized.prepare!(1024)).rejects.toMatchObject({ attachmentFailure: "size" }); }
  finally { await oversized.cancel!(); }
  expect(platform.downloads.some(item => item.key === "file_known_big")).toBe(false);
});

it("uses the configured bot token despite inherited personal CLI and agent credentials", async () => {
  const isolated = new FeishuCliDownloader(config, async () => "fake-tenant", { ...platform.cli.options, env: { ...platform.cli.options!.env,
    LARKSUITE_CLI_APP_ID: "cli_other_app", LARKSUITE_CLI_TENANT_ACCESS_TOKEN: "wrong-bot", LARKSUITE_CLI_USER_ACCESS_TOKEN: "wrong-user",
    LARKSUITE_CLI_PROFILE: "personal", LARKSUITE_CLI_AUTH_PROXY: "http://127.0.0.1:1", HERMES_HOME: "/missing/hermes" } });
  const resource = await isolated.download(message, attachment);
  try {
    await resource.prepare!(1024);
    expect(Buffer.concat(await resource.stream.toArray()).toString()).toBe("%PDF-fixture");
  } finally { await resource.cancel!(); isolated.close(); }
});

it("keeps permission failures safe and starts no inference", async () => {
  platform.resources.set("om_cli_resource:file_denied", { bytes: Buffer.from("private"), mime: "text/plain", status: 403 });
  const resource = await downloader.download(message, { ...attachment, key: "file_denied" });
  try { await expect(resource.prepare!(1024)).rejects.toMatchObject({ attachmentFailure: "permission", retryable: false }); }
  finally { await resource.cancel!(); }
});

it("lets the real CLI stream a large attachment in ranges and retry a failed range", async () => {
  const size = 101 * 1024 * 1024 + 17;
  platform.resources.set("om_cli_resource:file_big", { bytes: Buffer.alloc(0), size, mime: "application/octet-stream", failRangeOnce: 32 * 1024 * 1024 });
  const resource = await downloader.download(message, { ...attachment, key: "file_big", name: "record.mcap" });
  try {
    expect(await resource.prepare!(512 * 1024 * 1024)).toMatchObject({ bytes: size, mime: "application/octet-stream" });
    let count = 0, largest = 0;
    for await (const chunk of resource.stream) { count += chunk.length; largest = Math.max(largest, chunk.length); expect(chunk[0]).toBe(97); }
    expect(count).toBe(size); expect(largest).toBeLessThanOrEqual(64 * 1024);
    expect(platform.downloads.filter(item => item.key === "file_big" && item.range?.startsWith("bytes=33554432-"))).toHaveLength(2);
  } finally { await resource.cancel!(); }
}, 15_000);

it("exposes live saved-byte progress and cancels the CLI process before deleting its staging folder", async () => {
  platform.resources.set("om_cli_resource:file_slow", { bytes: Buffer.alloc(0), size: 34 * 1024 * 1024, mime: "application/octet-stream", rangeChunkDelayMs: 10 });
  const resource = await downloader.download(message, { ...attachment, key: "file_slow", name: "slow.mcap" });
  const preparing = resource.prepare!(512 * 1024 * 1024);
  void preparing.catch(() => undefined);
  try {
    await expect.poll(() => resource.progress!().received, { timeout: 5000 }).toBeGreaterThan(256 * 1024);
    expect(resource.progress!().total).toBeUndefined();
    await resource.cancel!();
    await expect(preparing).rejects.toMatchObject({ attachmentFailure: "download" });
    expect(readdirSync(platform.cli.options!.tempRoot!).filter(name => name.startsWith("openmaus-feishu-cli-"))).toEqual([]);
  } finally { await resource.cancel!(); }
});

it("stops an oversized staged transfer and reports an unavailable CLI", async () => {
  platform.resources.set("om_cli_resource:file_oversize", { bytes: Buffer.alloc(1024), mime: "application/octet-stream" });
  const resource = await downloader.download(message, { ...attachment, key: "file_oversize" });
  try { await expect(resource.prepare!(512)).rejects.toMatchObject({ attachmentFailure: "size" }); }
  finally { await resource.cancel!(); }
  const missing = new FeishuCliDownloader(config, async () => "fake-tenant", { ...platform.cli.options, cli: "/missing/openmaus-lark-cli" });
  const unavailable = await missing.download(message, attachment);
  try { await expect(unavailable.prepare!(1024)).rejects.toMatchObject({ attachmentFailure: "cli" }); }
  finally { await unavailable.cancel!(); missing.close(); }
});

it("rejects a resource with inconsistent range metadata without publishing a partial file", async () => {
  platform.resources.set("om_cli_resource:file_corrupt", { bytes: Buffer.from("abc"), mime: "text/plain", shiftRangeAt: 0 });
  const resource = await downloader.download(message, { ...attachment, key: "file_corrupt", name: "corrupt.txt" });
  try { await expect(resource.prepare!(1024)).rejects.toMatchObject({ attachmentFailure: "integrity" }); }
  finally { await resource.cancel!(); }
});
