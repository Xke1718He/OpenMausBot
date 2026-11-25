import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "../atomic.ts";

const menuSchema = z.object({
  id: z.string(), route: z.string(), senderId: z.string(), chatId: z.string(), kind: z.enum(["direct", "group"]),
  messageId: z.string().optional(), expiresAt: z.number(), selected: z.boolean().default(false),
  bots: z.array(z.object({ id: z.string(), name: z.string(), title: z.string().optional(), description: z.string().optional() })),
});
const routingSchema = z.object({
  version: z.literal(1), scope: z.string(), botIds: z.array(z.string()),
  selections: z.record(z.string(), z.string()), menus: z.array(menuSchema),
}).strict();
export type FeishuBotMenu = z.infer<typeof menuSchema>;

export class FeishuBotRoutingState {
  data: z.infer<typeof routingSchema>;
  private readonly path: string;
  constructor(path: string, scope: string) {
    this.path = path;
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read Feishu bot routing state"); }
    this.data = routingSchema.parse(raw ?? { version: 1, scope, botIds: [], selections: {}, menus: [] });
    if (this.data.scope !== scope) throw new Error("Feishu bot routing state belongs to another connection");
  }
  save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.path, JSON.stringify(this.data), { mode: 0o600 });
  }
  update(change: () => void): void {
    const previous = structuredClone(this.data);
    try { change(); this.save(); } catch (error) { this.data = previous; throw error; }
  }
}
