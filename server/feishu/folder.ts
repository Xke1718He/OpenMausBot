import { z } from "zod";
import { ChatRuntimeError, MAX_EXPANDED_ATTACHMENTS, type ChatAttachmentExpansion, type ChatResolvedAttachment } from "../messaging/contracts.ts";

const count = z.coerce.number().int().nonnegative().safe();
const node = z.object({
  file_key: z.string().regex(/^file_[\w-]{1,512}$/), name: z.string().min(1).max(512), is_folder: z.boolean(),
  children_count: count.optional(), children: z.array(z.unknown()).max(1024).optional(),
  size: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().nonnegative().safe()).optional().catch(undefined),
});
const listing = z.object({ items: z.array(z.unknown()).max(1024), all_count: count });
const invalid = () => new ChatRuntimeError("Folder listing cannot be processed completely", false, "folder");
const safeName = (name: string) => ![".", ".."].includes(name) && !/[/\\]/.test(name) &&
  !Array.from(name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export function folderFiles(value: unknown, name: string): ChatAttachmentExpansion {
  const result = listing.safeParse(value);
  if (!result.success || !safeName(name)) throw invalid();
  const files: ChatResolvedAttachment[] = [];
  const directories = [name];
  const folders = new Set<string>();
  const paths = new Set<string>();
  let nodes = 0, pathBytes = 0;
  const walk = (items: unknown[], parent: string, depth: number) => {
    if (depth > 32) throw invalid();
    for (const raw of items) {
      if (++nodes > 1024) throw invalid();
      const parsed = node.safeParse(raw);
      if (!parsed.success || !safeName(parsed.data.name)) throw invalid();
      const item = parsed.data, path = `${parent}/${item.name}`;
      if (path.length > 4096 || paths.has(path)) throw invalid();
      paths.add(path);
      if (item.is_folder) {
        const children = item.children ?? (item.children_count === 0 ? [] : undefined);
        if (folders.has(item.file_key) || !children || item.children_count !== undefined && item.children_count !== children.length) throw invalid();
        folders.add(item.file_key);
        directories.push(path);
        walk(children, path, depth + 1);
      } else {
        pathBytes += Buffer.byteLength(path);
        if (files.length >= MAX_EXPANDED_ATTACHMENTS || pathBytes > 64 * 1024) throw invalid();
        files.push({ kind: "file", key: item.file_key, name: item.name, sourcePath: path, ...(item.size === undefined ? {} : { bytes: item.size }) });
      }
    }
  };
  walk(result.data.items, name, 1);
  // Feishu's recursive folder response counts the root in all_count (observed with SDK 1.76.0 and CLI 1.0.97).
  if (result.data.all_count !== nodes + 1) throw invalid();
  return { attachments: files, directories };
}
