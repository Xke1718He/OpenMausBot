import type { Client } from "@larksuiteoapi/node-sdk";
import { Readable } from "node:stream";
import { z } from "zod";
import { ChatRuntimeError, MAX_EXPANDED_ATTACHMENTS, type ChatAttachment, type ChatAttachmentExpansion, type ChatMessage } from "../messaging/contracts.ts";
import { folderFiles } from "./folder.ts";

const size = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
};

function resourceBytes(headers: Record<string, unknown>, status: number | undefined): number | undefined {
  if (headers["content-encoding"] && headers["content-encoding"] !== "identity") return undefined;
  const range = headers["content-range"];
  if (status === 206) {
    if (range === "bytes */0" && [undefined, "0"].includes(headers["content-length"] as string | undefined)) return 0;
    const match = typeof range === "string" ? /^bytes 0-0\/(\d+)$/.exec(range) : null;
    if (!match || headers["content-length"] !== undefined && headers["content-length"] !== "1") return undefined;
    const total = size(match[1]);
    return total && total > 0 ? total : undefined;
  }
  return status === 200 && range === undefined ? size(headers["content-length"]) : undefined;
}

export class FeishuResourceMetadata {
  private readonly active = new Set<AbortController>();
  private closed = false;
  private readonly client: Pick<Client, "request">;
  constructor(client: Pick<Client, "request">) { this.client = client; }

  close(): void { this.closed = true; for (const controller of this.active) controller.abort(); }

  async size(message: ChatMessage, attachment: ChatAttachment, signal: AbortSignal): Promise<number | undefined> {
    if (attachment.bytes !== undefined) return attachment.bytes;
    if (attachment.sizeChecked) return undefined;
    if (this.closed || signal.aborted) return undefined;
    const controller = new AbortController(); this.active.add(controller);
    let stream: Readable | undefined;
    try {
      const request = { method: "GET", url: `/open-apis/im/v1/messages/${message.id}/resources/${attachment.key}`, params: { type: attachment.kind },
        headers: { Range: "bytes=0-0", "Accept-Encoding": "identity" }, responseType: "stream" as const, $return_headers: true,
        signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(5_000)]), timeout: 5_000, maxRedirects: 0 };
      const result = await this.client.request<{ data: unknown; headers: Record<string, unknown>; status?: number }>(request);
      if (!(result.data instanceof Readable)) return undefined;
      stream = result.data;
      return resourceBytes(result.headers, result.status);
    } catch (error) {
      const response = (error as { response?: { data?: unknown; headers?: Record<string, unknown>; status?: number } }).response;
      if (response?.data instanceof Readable) stream = response.data;
      if (response?.status === 416 && response.headers?.["content-range"] === "bytes */0") return 0;
      return undefined;
    } finally { stream?.destroy(); this.active.delete(controller); }
  }

  async expand(message: ChatMessage, signal: AbortSignal): Promise<ChatAttachmentExpansion> {
    const controller = new AbortController(); this.active.add(controller);
    const stage = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(15_000)]);
    const expanded: ChatAttachmentExpansion = { attachments: [], directories: [] };
    try {
      for (const attachment of message.attachments ?? []) {
        if (this.closed || signal.aborted) throw new ChatRuntimeError("Attachment metadata cancelled", false, "download");
        if (attachment.kind !== "folder") { expanded.attachments.push({ ...attachment, kind: attachment.kind }); continue; }
        const result = await this.client.request<{ code: number; data?: unknown }>({ method: "GET", url: `/open-apis/im/v1/files/${attachment.key}/folder`,
          params: { recursive: true, srctype: "message", srcid: message.id }, signal: stage, timeout: 15_000, maxContentLength: 2 * 1024 * 1024 });
        if (result.code !== 0) throw Object.assign(new Error("Folder metadata refused"), { response: { data: result } });
        const folder = folderFiles(result.data, attachment.name);
        expanded.attachments.push(...folder.attachments); expanded.directories.push(...folder.directories);
        if (expanded.attachments.length > MAX_EXPANDED_ATTACHMENTS || expanded.directories.length > 1024) throw new ChatRuntimeError("Folder expansion exceeds limits", false, "folder");
      }
      for (let offset = 0; offset < expanded.attachments.length && !stage.aborted; offset += 4) {
        await Promise.all(expanded.attachments.slice(offset, offset + 4).map(async attachment => {
          const bytes = await this.size(message, attachment, stage);
          if (bytes !== undefined) attachment.bytes = bytes;
          else attachment.sizeChecked = true;
        }));
      }
      if (stage.aborted) for (const attachment of expanded.attachments) if (attachment.bytes === undefined) attachment.sizeChecked = true;
      if (this.closed || signal.aborted) throw new ChatRuntimeError("Attachment metadata cancelled", false, "download");
      return expanded;
    } catch (error) {
      if (error instanceof ChatRuntimeError) throw error;
      const parsed = z.object({ response: z.object({ status: z.number().optional(), data: z.object({ code: z.number().optional() }).optional() }).optional() }).safeParse(error);
      const response = parsed.success ? parsed.data.response : undefined;
      const permission = [401, 403].includes(response?.status ?? 0) || [234009, 234038, 234040, 99991663, 99991668, 99991672].includes(response?.data?.code ?? 0);
      throw new ChatRuntimeError("Folder metadata could not be loaded", false, permission ? "permission" : "network");
    } finally { this.active.delete(controller); }
  }
}
