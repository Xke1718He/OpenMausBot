import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const component = (value: string) => Boolean(value) && ![".", ".."].includes(value) && !/[/\\]/.test(value) &&
  Buffer.byteLength(value) <= 255 && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
  (process.platform !== "win32" || !/[<>:"|?*]/.test(value) && !/[. ]$/.test(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value));
export const attachmentRelativePath = z.string().min(1).max(4096).refine(value => value.split("/").length <= 33 && value.split("/").every(component));
export const attachmentBatchId = z.string().uuid();
export interface AttachmentLayout { batchId: string; relativePath: string }

export async function attachmentBatchDirectory(directory: string, batchId: string, directories: string[] = []): Promise<string> {
  const id = attachmentBatchId.parse(batchId);
  const paths = z.array(attachmentRelativePath).max(1024).parse(directories);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  const ensure = async (parts: string[]) => {
    let path = root;
    for (const part of parts) {
      path = join(path, part);
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw Object.assign(new Error("Attachment directory must not be a symbolic link"), { status: 409 });
    }
    return path;
  };
  const batch = await ensure([id]);
  for (const path of paths) await ensure([id, ...path.split("/")]);
  return batch;
}

export async function attachmentLayoutPath(directory: string, layout: AttachmentLayout, originalName?: string): Promise<string> {
  const path = attachmentRelativePath.parse(layout.relativePath);
  const parts = path.split("/");
  if (originalName !== undefined && parts.at(-1) !== originalName) throw Object.assign(new Error("Original filename must match the relative path"), { status: 400 });
  const root = await attachmentBatchDirectory(directory, layout.batchId, parts.length > 1 ? [parts.slice(0, -1).join("/")] : []);
  const target = join(root, ...parts);
  try {
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink()) throw Object.assign(new Error("Attachment destination must be a regular file"), { status: 409 });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return target;
}
