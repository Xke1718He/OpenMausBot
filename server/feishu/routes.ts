import { PASS, type RouteHandler } from "../routes/table.ts";
import { connectionInputSchema } from "./connection-store.ts";
import { FeishuServiceError, type FeishuService } from "./service.ts";
import { attachmentStorageUsage, ATTACHMENTS_DIR, ATTACHMENTS_MAX_BYTES, IMAGE_MAX_BYTES, saveFile, saveImageUpload, validateAttachmentUploadId } from "../attachments.ts";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { attachmentBatchDirectory, attachmentBatchId, attachmentRelativePath } from "../attachment-layout.ts";
import { isLoopbackHost } from "../request-auth.ts";
import { resolveDownloadDirectory, saveDirectoryDownload } from "./download-directory.ts";

export function createFeishuRoutes(service: FeishuService): RouteHandler {
  return async ({ path, method, auth, req, res, json, readBody, url }) => {
    if (path === "/api/feishu/files" || path === "/api/feishu/directories") {
      res.setHeader("cache-control", "no-store");
      if (service.status().state === "blocked" || !auth.scopes.includes("admin") || auth.kind !== "session" || auth.via !== "bearer" ||
        !isLoopbackHost(req.headers.host) || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")) {
        req.resume(); return json(res, 403, { error: "Local owner connector session required" });
      }
      try {
        const directory = url.searchParams.get("directory");
        if (directory !== null) resolveDownloadDirectory(directory);
        if (path === "/api/feishu/directories") {
          if (method !== "POST") return json(res, 405, { error: "method not allowed" });
          const input = z.object({ batchId: attachmentBatchId, directories: z.array(attachmentRelativePath).max(1024) }).strict().parse(await readBody(req, 256 * 1024));
          return json(res, 201, { path: await attachmentBatchDirectory(directory ? resolveDownloadDirectory(directory) : ATTACHMENTS_DIR, input.batchId, input.directories) });
        }
        if (method === "GET") return json(res, 200, directory ? { maxFileBytes: Number.MAX_SAFE_INTEGER } : { maxFileBytes: ATTACHMENTS_MAX_BYTES, ...attachmentStorageUsage() });
        if (method !== "POST") return json(res, 405, { error: "method not allowed" });
        const uploadId = validateAttachmentUploadId(url.searchParams.get("uploadId") ?? undefined);
        const name = url.searchParams.get("name");
        if (!uploadId || !name) { req.resume(); return json(res, 400, { error: "name and uploadId are required" }); }
        const length = req.headers["content-length"];
        const chunks = req.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>;
        const mime = String(req.headers["content-type"] ?? "");
        const batch = url.searchParams.get("batchId"), relative = url.searchParams.get("relativePath");
        const layout = batch !== null || relative !== null ? { batchId: attachmentBatchId.parse(batch), relativePath: attachmentRelativePath.parse(relative) } : undefined;
        if (layout && layout.relativePath.split("/").at(-1) !== name) { req.resume(); return json(res, 400, { error: "name must match the original filename" }); }
        const options = { uploadId, expectedBytes: length === undefined ? undefined : Number(length), maxBytes: ATTACHMENTS_MAX_BYTES, allowEmpty: length === "0", layout };
        let nativePath: string | undefined;
        let content: AsyncIterable<Uint8Array> = chunks;
        if (url.searchParams.get("image") === "1") {
          const parts: Buffer[] = []; let bytes = 0;
          for await (const chunk of chunks) {
            bytes += chunk.length;
            if (bytes > IMAGE_MAX_BYTES) throw Object.assign(new Error("Image exceeds limit"), { status: 413 });
            parts.push(chunk);
          }
          if (options.expectedBytes !== undefined && bytes !== options.expectedBytes) throw Object.assign(new Error("Image length mismatch"), { status: 400 });
          nativePath = (await saveImageUpload(Buffer.concat(parts), mime, uploadId)).path;
          content = createReadStream(nativePath);
        }
        const saved = directory ? await saveDirectoryDownload(content, directory, name, mime, options) : await saveFile(content, name, mime, options);
        return json(res, 201, { ...saved, ...(nativePath ? { nativePath } : {}) });
      } catch (error) {
        req.resume();
        const problem = error as { status?: number; code?: string };
        const status = error instanceof z.ZodError ? 400 : problem.code === "ENOSPC" || problem.code === "EDQUOT" ? 507 : problem.status;
        return json(res, status === 400 || status === 409 || status === 413 || status === 507 ? status : 500, { error: "Could not save the connector attachment" });
      }
    }
    if (path !== "/api/feishu") return PASS;
    res.setHeader("cache-control", "no-store");
    if (!auth.scopes.includes("admin")) return json(res, 403, { error: "An owner or admin must connect Feishu", code: "admin" });
    if (method === "GET") return json(res, 200, service.status());
    try {
      if (method === "DELETE") return json(res, 200, await service.disconnect());
      if (method !== "PUT") return json(res, 405, { error: "method not allowed" });
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "Send connection details as JSON", code: "configuration" });
      const parsed = connectionInputSchema.safeParse(await readBody(req, 16_384));
      if (!parsed.success) return json(res, 400, { error: "Check the Feishu connection details", code: "configuration" });
      const owner = auth.kind === "session" ? { email: auth.session.email, userId: auth.session.userId } : {};
      return json(res, 200, await service.connect(parsed.data, owner));
    } catch (error) {
      const code = error instanceof FeishuServiceError ? error.code : "connection";
      return json(res, code === "busy" ? 409 : code === "blocked" ? 403 : code === "configuration" ? 400 : 502, { error: "Feishu could not connect. Check the app credentials, bot and allowed users, then try again.", code });
    }
  };
}
