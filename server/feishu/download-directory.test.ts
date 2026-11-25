import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { resolveDownloadDirectory, saveDirectoryDownload } from "./download-directory.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "omb-feishu-download-")); });
afterEach(async () => { await removeTempDir(root); });
const stream = async function* (value = "fixture data") { yield Buffer.from(value); };
const save = (uploadId: string = randomUUID(), chunks = stream(), name = "record.mcap", expectedBytes?: number) =>
  saveDirectoryDownload(chunks, join(root, "download"), name, "application/octet-stream", { uploadId, expectedBytes });

it("expands server home and rejects relative paths or control characters", () => {
  expect(resolveDownloadDirectory(" ~/download ")).toBe(join(homedir(), "download"));
  expect(resolveDownloadDirectory(root)).toBe(root);
  for (const path of ["download", "~other/download", "/tmp/bad\nfolder", ""]) expect(() => resolveDownloadDirectory(path)).toThrow();
});

it("creates the folder, preserves extensions and keeps same-name files separate", async () => {
  const first = await save(), second = await save();
  expect(first).toMatchObject({ name: "record.mcap", bytes: 12 });
  expect(first.path).toMatch(/--record\.mcap$/);
  expect(second.path).not.toBe(first.path);
  expect(await readFile(first.path, "utf8")).toBe("fixture data");
  expect(await readdir(join(root, "download"))).toHaveLength(2);
});

it("keeps exact relative paths inside a batch and never overwrites another batch or different content", async () => {
  const batchId = randomUUID(), directory = join(root, "download"), name = "数据  .mcap";
  const saveTree = (batch: string, relativePath: string, value = "fixture data") => saveDirectoryDownload(stream(value), directory, name, "application/octet-stream", {
    uploadId: randomUUID(), expectedBytes: Buffer.byteLength(value), layout: { batchId: batch, relativePath },
  });
  const first = await saveTree(batchId, `bag/nested/${name}`);
  expect(first.path).toBe(join(directory, batchId, "bag", "nested", name));
  expect(first.name).toBe(name);
  expect((await saveTree(batchId, `bag/nested/${name}`)).path).toBe(first.path);
  await expect(saveTree(batchId, `bag/nested/${name}`, "different")).rejects.toMatchObject({ status: 409 });
  const other = await saveTree(randomUUID(), `bag/nested/${name}`, "different");
  expect(other.path).not.toBe(first.path);
  expect(await readFile(first.path, "utf8")).toBe("fixture data");
});

it("saves and retries an explicitly zero-byte marker while rejecting truncated content", async () => {
  const id = randomUUID();
  const saved = await save(id, stream(""), "record.done", 0);
  expect(saved.bytes).toBe(0);
  expect((await save(id, stream(""), "record.done", 0)).path).toBe(saved.path);
  expect((await readFile(saved.path)).length).toBe(0);
  await expect(save(randomUUID(), stream(""), "record.done", 1)).rejects.toMatchObject({ status: 400 });
});

it("serializes retries, refuses changed bytes and allows redownload after manual cleanup", async () => {
  const id = randomUUID();
  const [first, retried] = await Promise.all([save(id), save(id)]);
  expect(first.path).toBe(retried.path);
  expect(await readdir(join(root, "download"))).toHaveLength(1);
  await expect(save(id, stream("different"))).rejects.toMatchObject({ status: 409 });
  expect(await readFile(first.path, "utf8")).toBe("fixture data");
  await unlink(first.path);
  expect((await save(id)).path).toBe(first.path);
});

it("cleans interrupted and truncated downloads without overwriting existing files", async () => {
  const broken = async function* () { yield Buffer.from("partial"); throw new Error("cancelled"); };
  await expect(save(randomUUID(), broken())).rejects.toThrow("cancelled");
  await expect(save(randomUUID(), stream(), "record.mcap", 20)).rejects.toMatchObject({ status: 400 });
  expect(await readdir(join(root, "download"))).toEqual([]);
  await expect(save(randomUUID(), stream(), "../escape.txt")).rejects.toMatchObject({ status: 400 });
});

it("refuses symbolic-link destinations and full-disk requests", async () => {
  const saved = await save();
  const id = saved.path.split("/").at(-1)!.split("--")[0]!;
  const target = join(root, "private.txt");
  await writeFile(target, "fixture data"); await unlink(saved.path); await symlink(target, saved.path);
  await expect(save(id)).rejects.toThrow();
  expect(await readFile(target, "utf8")).toBe("fixture data");
  await expect(save(randomUUID(), stream(), "huge.bin", Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({ status: 507 });
});

it("bounds filenames by UTF-8 bytes", async () => {
  const saved = await save(randomUUID(), stream(), `${"测".repeat(160)}.mcap`);
  expect(Buffer.byteLength(saved.path.split("/").at(-1)!)).toBeLessThanOrEqual(240);
  expect(saved.path.endsWith(".mcap")).toBe(true);
});
