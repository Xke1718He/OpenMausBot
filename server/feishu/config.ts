import { readFileSync } from "node:fs";
import { z } from "zod";
import { isAbsolute } from "node:path";

const userId = z.string().regex(/^ou_[\w-]+$/);
const chatId = z.string().regex(/^oc_[\w-]+$/);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const publicOrigin = z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
}, "publicUrl must be an HTTPS origin without credentials").transform(value => new URL(value).origin);

/** Configuration for `openmausbot feishu --config FILE`. Secrets are read only from the named environment variables. */
export const feishuConfigSchema = z.object({
  appId: z.string().regex(/^cli_[0-9a-fA-F]{16}$/),
  appSecretEnv: envName.default("FEISHU_APP_SECRET"),
  tokenEnv: envName.default("OPENMAUSBOT_TOKEN"),
  botId: z.string().regex(/^[\w-]+$/),
  url: z.string().url(),
  domain: z.enum(["feishu", "lark"]).default("feishu"),
  allowedUsers: z.array(userId).max(100),
  allowedChats: z.array(chatId).max(100).default([]),
  downloadDirectory: z.string().trim().min(1).max(4096).refine(value => Array.from(value).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) && (isAbsolute(value) || value === "~" || value.startsWith("~/")), "Use an absolute download directory or ~/").optional(),
  groupAccess: z.enum(["allowlist", "everyone"]).optional(),
  groupAccessByChat: z.record(chatId, z.enum(["allowlist", "everyone"])).optional(),
  publicUrl: publicOrigin.optional(),
}).strict();
export type FeishuConfig = z.infer<typeof feishuConfigSchema>;

export function readFeishuConfig(path: string): FeishuConfig {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Cannot read Feishu configuration JSON"); }
  const parsed = feishuConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid Feishu configuration: ${parsed.error.issues.map(issue => issue.path.join(".") || "unknown fields").join(", ")}`);
  return parsed.data;
}
