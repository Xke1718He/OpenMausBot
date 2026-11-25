import { mkdtemp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { removeTempDir } from "./testing/cleanup.ts";
import { attachmentBatchDirectory, attachmentLayoutPath } from "./attachment-layout.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "omb-attachment-layout-")); });
afterEach(async () => { await removeTempDir(root); });

it("preserves empty directories and exact folder and file names under one ID", async () => {
  const id = randomUUID(), base = join(root, "download");
  const batch = await attachmentBatchDirectory(base, id, ["原始数据/空目录"]);
  expect(batch).toBe(join(base, id));
  expect(await readdir(join(batch, "原始数据", "空目录"))).toEqual([]);
  expect(await attachmentLayoutPath(base, { batchId: id, relativePath: "原始数据/nested/a  b.mcap" }, "a  b.mcap")).toBe(join(batch, "原始数据", "nested", "a  b.mcap"));
});

it("rejects traversal, absolute paths, mismatched filenames and symbolic links in every position", async () => {
  const id = randomUUID(), base = join(root, "download"), outside = join(root, "outside");
  await mkdir(outside); await attachmentBatchDirectory(base, id);
  for (const relativePath of ["../escape", "/tmp/escape", "a/../../escape", "a\\b", "a/", "a\nfile"])
    await expect(attachmentLayoutPath(base, { batchId: id, relativePath })).rejects.toThrow();
  await expect(attachmentLayoutPath(base, { batchId: id, relativePath: "a.txt" }, "b.txt")).rejects.toMatchObject({ status: 400 });
  await symlink(outside, join(base, id, "linked"));
  await expect(attachmentLayoutPath(base, { batchId: id, relativePath: "linked/a.txt" })).rejects.toMatchObject({ status: 409 });
  await writeFile(join(outside, "private.txt"), "private");
  await symlink(join(outside, "private.txt"), join(base, id, "leaf.txt"));
  await expect(attachmentLayoutPath(base, { batchId: id, relativePath: "leaf.txt" })).rejects.toMatchObject({ status: 409 });
  const linkedId = randomUUID(); await symlink(outside, join(base, linkedId));
  await expect(attachmentBatchDirectory(base, linkedId)).rejects.toMatchObject({ status: 409 });
  expect(await readdir(outside)).toEqual(["private.txt"]);
});
