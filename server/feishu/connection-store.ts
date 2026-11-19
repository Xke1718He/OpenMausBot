import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";
import { decryptBrowserState, encryptBrowserState } from "../browser-sites.ts";
import { feishuConfigSchema } from "./config.ts";

export const connectionInputSchema = feishuConfigSchema.omit({ appSecretEnv: true, tokenEnv: true, url: true, publicUrl: true })
  .extend({ appSecret: z.string().trim().min(1).max(512).optional() }).strict();
const recordSchema = z.object({
  configuration: connectionInputSchema.omit({ appSecret: true }), appSecret: z.string().min(1), token: z.string().min(1), sessionId: z.string().min(1),
}).strict();
export type FeishuConnectionRecord = z.infer<typeof recordSchema>;

export class FeishuConnectionStore {
  private readonly file: string;
  private readonly keyFile: string;
  private readonly dir: string;
  constructor(dataDir: string) {
    this.dir = dataDir;
    this.file = join(dataDir, "feishu.json.enc");
    this.keyFile = join(dataDir, "feishu-key");
  }
  read(): FeishuConnectionRecord | null {
    let bytes: Buffer;
    try { bytes = readFileSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Cannot read the saved Feishu connection"); }
    try {
      return recordSchema.parse(JSON.parse(decryptBrowserState(bytes, readFileSync(this.keyFile, "utf8"))));
    } catch { throw new Error("Cannot unlock the saved Feishu connection"); }
  }
  write(record: FeishuConnectionRecord): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let key: string;
    try { key = readFileSync(this.keyFile, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      key = randomBytes(32).toString("hex");
      const fd = openSync(this.keyFile, "wx", 0o600);
      try { writeFileSync(fd, key); } finally { closeSync(fd); }
    }
    writeFileAtomic(this.file, encryptBrowserState(JSON.stringify(recordSchema.parse(record)), key), { mode: 0o600 });
  }
  clear(): void {
    try { unlinkSync(this.file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
