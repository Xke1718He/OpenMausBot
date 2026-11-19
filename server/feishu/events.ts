import { z } from "zod";
import type { ChatMessage } from "../messaging/contracts.ts";
import type { FeishuConfig } from "./config.ts";

const eventSchema = z.object({
  sender: z.object({ sender_type: z.literal("user"), sender_id: z.object({ open_id: z.string().regex(/^ou_[\w-]+$/) }) }),
  message: z.object({
    message_id: z.string().regex(/^om_[\w-]+$/), chat_id: z.string().regex(/^oc_[\w-]+$/),
    chat_type: z.enum(["p2p", "group"]), message_type: z.string(), content: z.string().max(100_000),
    root_id: z.string().optional(), thread_id: z.string().optional(),
    mentions: z.array(z.object({ key: z.string(), id: z.object({ open_id: z.string().optional() }) })).optional(),
  }),
});

function postText(value: unknown): string {
  const post = z.object({ title: z.string().optional(), content: z.array(z.array(z.object({
    tag: z.string(), text: z.string().optional(), href: z.string().optional(),
  }))) }).safeParse(value);
  if (!post.success) return "";
  return [post.data.title ?? "", ...post.data.content.map(line => line.map(item => item.text ?? item.href ?? "").join(""))].filter(Boolean).join("\n");
}

export function feishuMessage(raw: unknown, config: FeishuConfig, botOpenId: string): ChatMessage | null {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { sender, message } = parsed.data;
  const senderId = sender.sender_id.open_id;
  if (senderId === botOpenId || !config.allowedUsers.includes(senderId)) return null;
  const group = message.chat_type === "group";
  const mentions = message.mentions ?? [];
  if (group && (!config.allowedChats.includes(message.chat_id) || !mentions.some(mention => mention.id.open_id === botOpenId))) return null;
  let content: unknown;
  try { content = JSON.parse(message.content); } catch { return null; }
  let text = "";
  if (message.message_type === "text") {
    const result = z.object({ text: z.string() }).safeParse(content);
    if (result.success) text = result.data.text;
  } else if (message.message_type === "post") {
    const locale = z.record(z.string(), z.unknown()).safeParse(content);
    text = postText(content) || (locale.success ? postText(locale.data.zh_cn ?? locale.data.en_us) : "");
  }
  for (const mention of mentions) if (mention.id.open_id === botOpenId) text = text.split(mention.key).join("");
  text = text.trim();
  if (!text || text.length > 12_000) return null;
  return {
    platform: "feishu", account: config.appId, id: message.message_id, chatId: message.chat_id,
    senderId, kind: group ? "group" : "direct", text,
    ...(group ? { threadId: message.root_id || message.thread_id || message.message_id } : {}),
  };
}
