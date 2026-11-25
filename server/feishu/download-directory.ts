import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, realpath, statfs, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";
import { sanitizeSharedFileName, validateAttachmentUploadId, type SavedFile } from "../attachments.ts";
import { feishuConfigSchema } from "./config.ts";
import { attachmentLayoutPath, type AttachmentLayout } from "../attachment-layout.ts";

const locks = new Map<string, Promise<void>>();
const DISK_RESERVE = 64 * 1024 * 1024;
const directorySchema = feishuConfigSchema.shape.downloadDirectory.unwrap();
const problem = (status: number, message: string) => Object.assign(new Error(message), { status });

export function resolveDownloadDirectory(value: string): string {
  const parsed = directorySchema.safeParse(value);
  if (!parsed.success) throw problem(400, "Use an absolute download directory or ~/");
  const path = parsed.data;
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

function storedName(id: string, name: string): string {
  const extension = extname(name);
  let stem = name.slice(0, name.length - extension.length);
  while (Buffer.byteLength(`${id}--${stem}${extension}`) > 240) stem = Array.from(stem).slice(0, -1).join("");
  return `${id}--${stem}${extension}`;
}

async function availableBytes(directory: string): Promise<number> {
  const space = await statfs(directory);
  return Math.max(0, space.bavail * space.bsize - DISK_RESERVE);
}

async function fileDigest(path: string): Promise<{ bytes: number; hash: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw problem(409, "Download destination is not a regular file");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    return { bytes: stat.size, hash: hash.digest("hex") };
  } finally { await file.close(); }
}

export async function saveDirectoryDownload(chunks: AsyncIterable<Uint8Array>, directory: string, originalName: string, mime: string,
  options: { uploadId: string; expectedBytes?: number; layout?: AttachmentLayout }): Promise<SavedFile> {
  const id = validateAttachmentUploadId(options.uploadId);
  if (!id) throw problem(400, "uploadId is required");
  const name = options.layout ? originalName : sanitizeSharedFileName(originalName, mime);
  const expected = options.expectedBytes;
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) throw problem(400, "Invalid content-length");
  await mkdir(resolveDownloadDirectory(directory), { recursive: true, mode: 0o700 });
  const root = await realpath(resolveDownloadDirectory(directory));
  const path = options.layout ? await attachmentLayoutPath(root, options.layout, name) : join(root, storedName(id, name));
  const key = options.layout ? path : join(root, id);
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  locks.set(key, current);
  await previous;
  const partial = join(root, `.openmaus-feishu-${id}-${randomUUID()}.partial`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    let existing: string | undefined;
    if (options.layout) {
      try { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); await file.close(); existing = path; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    } else existing = (await readdir(root)).find(entry => entry.startsWith(`${id}--`));
    if (existing && !options.layout && join(root, existing) !== path) throw problem(409, "uploadId was used for another filename");
    const prior = existing ? await fileDigest(path) : undefined;
    if (!prior && expected !== undefined && expected > await availableBytes(root)) throw problem(507, "Download disk is full");
    if (!prior) file = await open(partial, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    let diskCheckAt = 0;
    for await (const value of chunks) {
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (!chunk.byteLength) continue;
      if (expected !== undefined && bytes + chunk.byteLength > expected) throw problem(400, "Download exceeds content-length");
      if (file) {
        if (bytes >= diskCheckAt) {
          if (chunk.byteLength > await availableBytes(root)) throw problem(507, "Download disk is full");
          diskCheckAt = bytes + 8 * 1024 * 1024;
        }
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await file.write(chunk, offset, chunk.byteLength - offset, null);
          if (!result.bytesWritten) throw new Error("Download write made no progress");
          offset += result.bytesWritten;
        }
      }
      hash.update(chunk); bytes += chunk.byteLength;
    }
    if (!bytes && expected !== 0 || expected !== undefined && bytes !== expected) throw problem(400, "Download length mismatch");
    const digest = hash.digest("hex");
    if (prior) {
      if (prior.bytes !== bytes || prior.hash !== digest) throw problem(409, "uploadId was used for different bytes");
    } else {
      await file!.close(); file = undefined;
      try { await link(partial, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const other = await fileDigest(path);
        if (other.bytes !== bytes || other.hash !== digest) throw problem(409, "Download destination already exists");
      }
    }
    return { path, name, mime, bytes };
  } finally {
    try {
      await file?.close().catch(() => undefined);
      await unlink(partial).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    } finally {
      release();
      if (locks.get(key) === current) locks.delete(key);
    }
  }
}
