import { createReadStream, lstatSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { augmentedPath, findCliCandidates, resolveCliSpawn } from "../env-path.ts";
import { execFileInGroupAsync } from "../group-exec.ts";
import { ChatRuntimeError, type AttachmentFailure, type ChatAttachment, type ChatDownloadedAttachment, type ChatMessage } from "../messaging/contracts.ts";
import { mimeFor } from "../message-file.ts";
import type { FeishuConfig } from "./config.ts";

export interface FeishuCliDownloadOptions {
  cli?: string;
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
}

const savedFileSchema = z.object({ saved_path: z.string(), size_bytes: z.number().int().nonnegative().safe() });
const resultSchema = z.object({ ok: z.literal(true), identity: z.literal("bot"), data: savedFileSchema });
const emptyFileSchema = savedFileSchema.extend({ size_bytes: z.literal(0) });
const errorSchema = z.object({ error: z.object({ type: z.string().optional(), subtype: z.string().optional(), code: z.coerce.number().optional(), message: z.string().optional() }) });
const errorFor = (failure: AttachmentFailure) => new ChatRuntimeError("Feishu CLI attachment transfer failed", false, failure);

function envelope(text: string): unknown {
  for (const match of [...text.matchAll(/\{\s*"ok"\s*:\s*(?:true|false)/g)].reverse()) {
    try { return JSON.parse(text.slice(match.index)); } catch { }
  }
  throw errorFor("integrity");
}

function cliFailure(error: unknown): ChatRuntimeError {
  const problem = error as { code?: number | string; stderr?: string; killed?: boolean };
  let details: z.infer<typeof errorSchema>["error"] = {};
  try { details = errorSchema.parse(envelope(problem.stderr ?? "")).error; } catch { }
  const httpCode = details.code;
  const body = /^HTTP\s+\d+:\s*(\{[\s\S]*\})$/.exec(details.message ?? "");
  if (body) { try { details.code = z.object({ code: z.number() }).parse(JSON.parse(body[1]!)).code; } catch { } }
  if (problem.code === "ENOENT") return errorFor("cli");
  if (problem.code === "ENOSPC" || problem.code === "EDQUOT" || /disk.*full|no space left|disk quota|ENOSPC|EDQUOT/i.test(problem.stderr ?? "")) return errorFor("storage");
  if ([401, 403, 234009, 234038, 234040, 99991663, 99991668].includes(details.code ?? 0) || ["authorization", "authentication"].includes(details.type ?? "") || problem.code === 3) return errorFor("permission");
  if (details.code === 413 || details.code === 234037) return errorFor("size");
  if ([416, 234045, 234046].includes(details.code ?? 0)) return errorFor("range");
  if (details.subtype?.includes("mismatch") || details.subtype?.includes("integrity") || details.subtype === "protocol" || /content-range|range response|size mismatch|length mismatch|representation|unexpected EOF/i.test(details.message ?? "")) return errorFor("integrity");
  if (httpCode && httpCode >= 400 && httpCode < 500 && httpCode !== 429) return errorFor("download");
  if (details.type === "network" || problem.code === 4 || problem.killed || ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"].includes(String(problem.code))) return errorFor("network");
  if (details.type === "validation" || details.type === "configuration") return errorFor("cli");
  return errorFor("download");
}

function emptyRangeResponse(error: unknown): boolean {
  try {
    const parsed = errorSchema.parse(envelope((error as { stderr?: string }).stderr ?? "")).error;
    return parsed.type === "network" && parsed.subtype === "protocol" &&
      parsed.message === 'invalid Content-Range header on range response: unsupported content-range: "bytes */0"';
  } catch { return false; }
}

function environment(root: string, config: FeishuConfig, token: string, supplied: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "LARKSUITE_CLI_PROXY_ENABLE", "LARKSUITE_CLI_PROXY_ADDRESS", "LARKSUITE_CLI_CA_PATH"]) if (supplied[key]) env[key] = supplied[key];
  return { ...env, PATH: supplied.PATH ?? augmentedPath(), HOME: join(root, "home"), USERPROFILE: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "config"), APPDATA: join(root, "config"), LOCALAPPDATA: join(root, "config"),
    LARKSUITE_CLI_CONFIG_DIR: join(root, "config"), LARKSUITE_CLI_DATA_DIR: join(root, "data"), LARKSUITE_CLI_LOG_DIR: join(root, "logs"),
    LARKSUITE_CLI_APP_ID: config.appId, LARKSUITE_CLI_TENANT_ACCESS_TOKEN: token, LARKSUITE_CLI_BRAND: config.domain,
    LARKSUITE_CLI_DEFAULT_AS: "bot", LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" };
}

async function imageMime(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(12); await file.read(bytes, 0, bytes.length, 0);
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
    if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) return "image/gif";
    if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
    throw errorFor("upload");
  } finally { await file.close(); }
}

export class FeishuCliDownloader {
  private readonly active = new Set<() => Promise<void>>();
  private closed = false;
  private readonly config: FeishuConfig;
  private readonly token: () => Promise<string>;
  private readonly options: FeishuCliDownloadOptions;
  private readonly resourceSize?: (message: ChatMessage, attachment: ChatAttachment, signal: AbortSignal) => Promise<number | undefined>;

  constructor(config: FeishuConfig, token: () => Promise<string>, options: FeishuCliDownloadOptions = {}, resourceSize?: (message: ChatMessage, attachment: ChatAttachment, signal: AbortSignal) => Promise<number | undefined>) {
    this.config = config; this.token = token; this.options = options; this.resourceSize = resourceSize;
  }

  close(): void { this.closed = true; for (const cancel of this.active) void cancel().catch(() => undefined); }

  async download(message: ChatMessage, attachment: ChatAttachment): Promise<ChatDownloadedAttachment> {
    if (attachment.kind === "folder") throw errorFor("folder");
    if (this.closed) throw errorFor("download");
    const cli = this.options.cli ?? findCliCandidates("lark-cli")[0];
    if (!cli) throw errorFor("cli");
    const root = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), "openmaus-feishu-cli-")).catch(error => { throw cliFailure(error); });
    const folder = join(root, "download"), output = join(folder, "attachment.bin");
    try {
      await mkdir(folder, { mode: 0o700 }); await mkdir(join(root, "home"), { mode: 0o700 });
      if (this.closed) throw errorFor("download");
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error instanceof ChatRuntimeError ? error : cliFailure(error); }
    const controller = new AbortController();
    let received = 0, total = attachment.bytes, pending: Promise<{ mime: string; bytes: number }> | undefined;
    let limit = Number.MAX_SAFE_INTEGER;
    const progress = () => {
      try { for (const entry of readdirSync(folder)) { const file = lstatSync(join(folder, entry)); if (file.isFile()) received = Math.max(received, file.size); } } catch { }
      return { received, transferred: received, ...(total === undefined ? {} : { total }) };
    };
    const cancel = async () => {
      controller.abort(errorFor("download")); stream.destroy();
      await pending?.catch(() => undefined);
      await rm(root, { recursive: true, force: true }); this.active.delete(cancel);
    };
    const prepare = (maxBytes: number) => {
      limit = Math.min(limit, maxBytes);
      pending ??= (async () => {
        let timer: ReturnType<typeof setInterval> | undefined;
        try {
          if (controller.signal.aborted) throw controller.signal.reason;
          total ??= await this.resourceSize?.(message, attachment, controller.signal);
          if (controller.signal.aborted) throw controller.signal.reason;
          if (total !== undefined && total > limit) throw errorFor("size");
          const token = await this.token();
          if (controller.signal.aborted) throw controller.signal.reason;
          const env = environment(root, this.config, token, this.options.env ?? process.env);
          const args = ["im", "+messages-resources-download", "--as", "bot", "--message-id", message.id, "--file-key", attachment.key, "--type", attachment.kind, "--output", "attachment.bin", "--format", "json"];
          const command = resolveCliSpawn(cli, args, env);
          timer = setInterval(() => {
            if (progress().received > limit) controller.abort(errorFor("size"));
            void statfs(root).then(space => { if (space.bavail * space.bsize < 64 * 1024 * 1024) controller.abort(errorFor("storage")); }).catch(() => undefined);
          }, 200); timer.unref();
          let saved: z.infer<typeof savedFileSchema>;
          try {
            const result = await execFileInGroupAsync(command.command, command.args, { cwd: folder, env, signal: controller.signal, timeout: 30 * 60_000, maxBuffer: 256 * 1024 });
            const parsed = resultSchema.safeParse(envelope(result.stdout));
            if (!parsed.success) throw errorFor("integrity");
            saved = parsed.data.data;
          } catch (error) {
            if (attachment.kind !== "file" || !emptyRangeResponse(error)) throw error;
            // lark-cli 1.0.97 rejects Feishu's 206 "bytes */0"; a complete CLI download must confirm the file is empty.
            const fallback = resolveCliSpawn(cli, ["api", "GET", `/open-apis/im/v1/messages/${message.id}/resources/${attachment.key}`,
              "--params", '{"type":"file"}', "--as", "bot", "--output", "attachment.bin", "--format", "json"], env);
            const result = await execFileInGroupAsync(fallback.command, fallback.args, { cwd: folder, env, signal: controller.signal, timeout: 15_000, maxBuffer: 256 * 1024 });
            let value: unknown;
            try { value = JSON.parse(result.stdout); } catch { throw errorFor("integrity"); }
            const parsed = emptyFileSchema.safeParse(value);
            if (!parsed.success) throw errorFor("integrity");
            saved = parsed.data;
          }
          if (resolve(saved.saved_path) !== output) throw errorFor("integrity");
          const file = lstatSync(output);
          if (!file.isFile() || file.isSymbolicLink() || file.size !== saved.size_bytes) throw errorFor("integrity");
          if (total !== undefined && file.size !== total) throw errorFor("integrity");
          total = file.size; received = total;
          if (total > limit) throw errorFor("size");
          return { mime: attachment.kind === "image" ? await imageMime(output) : mimeFor(attachment.name), bytes: total };
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          if (error instanceof ChatRuntimeError) throw error;
          throw cliFailure(error);
        } finally { if (timer) clearInterval(timer); }
      })();
      return pending;
    };
    const active = this.active;
    const stream = Readable.from((async function* () {
      try { await prepare(limit); yield* createReadStream(output); }
      finally { await rm(root, { recursive: true, force: true }); active.delete(cancel); }
    })());
    this.active.add(cancel);
    return { stream, mime: attachment.kind === "image" ? "application/octet-stream" : mimeFor(attachment.name), prepare, cancel, progress };
  }
}
