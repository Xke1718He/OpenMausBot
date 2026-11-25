import { z } from "zod";
import type { ChatAttachment, ChatMessage } from "../messaging/contracts.ts";
import type { FeishuConfig } from "./config.ts";
import { feishuMessageAllowed } from "./access.ts";

const eventSchema = z.object({
  sender: z.object({ sender_type: z.literal("user"), sender_id: z.object({ open_id: z.string().regex(/^ou_[\w-]+$/) }) }),
  message: z.object({
    message_id: z.string().regex(/^om_[\w-]+$/), chat_id: z.string().regex(/^oc_[\w-]+$/),
    chat_type: z.enum(["p2p", "group"]), message_type: z.string(), content: z.string().max(100_000),
    root_id: z.string().optional(), thread_id: z.string().optional(), parent_id: z.string().optional(),
    mentions: z.array(z.object({ key: z.string(), id: z.object({ open_id: z.string().optional() }) })).optional(),
  }),
});

function postContent(value: unknown): { text: string; attachments: ChatAttachment[] } | null {
  const post = z.object({ title: z.string().optional(), content: z.array(z.array(z.object({
    tag: z.string(), text: z.string().optional(), href: z.string().optional(), image_key: z.string().regex(/^img_[\w-]{1,512}$/).optional(),
  }))) }).safeParse(value);
  if (!post.success) return null;
  const attachments: ChatAttachment[] = post.data.content.flat().flatMap((item, index) => item.tag === "img" && item.image_key
    ? [{ kind: "image" as const, key: item.image_key, name: `image-${index + 1}.jpg` }] : []);
  return { text: [post.data.title ?? "", ...post.data.content.map(line => line.map(item => item.text ?? item.href ?? "").join(""))].filter(Boolean).join("\n"), attachments };
}

export function feishuMessage(
  raw: unknown,
  config: FeishuConfig,
  botOpenId: string,
  hasRoute: (message: ChatMessage) => boolean = () => false,
): ChatMessage | null {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { sender, message } = parsed.data;
  const senderId = sender.sender_id.open_id;
  if (senderId === botOpenId) return null;
  const group = message.chat_type === "group";
  if (!feishuMessageAllowed({ kind: group ? "group" : "direct", chatId: message.chat_id, senderId }, config)) return null;
  const mentions = message.mentions ?? [];
  let content: unknown;
  try { content = JSON.parse(message.content); } catch { return null; }
  let text = "";
  let attachments: ChatAttachment[] = [];
  if (message.message_type === "text") {
    const result = z.object({ text: z.string() }).safeParse(content);
    if (result.success) text = result.data.text;
  } else if (message.message_type === "post") {
    const locale = z.record(z.string(), z.unknown()).safeParse(content);
    const post = postContent(content) ?? (locale.success ? postContent(locale.data.zh_cn ?? locale.data.en_us) : null);
    if (post) { text = post.text; attachments = post.attachments; }
  } else if (message.message_type === "file" || message.message_type === "folder") {
    const file = z.object({ file_key: z.string().regex(/^file_[\w-]{1,512}$/), file_name: z.string().min(1).max(512) }).safeParse(content);
    if (file.success) attachments = [{ kind: message.message_type, key: file.data.file_key, name: file.data.file_name }];
  } else if (message.message_type === "image") {
    const image = z.object({ image_key: z.string().regex(/^img_[\w-]{1,512}$/) }).safeParse(content);
    if (image.success) attachments = [{ kind: "image", key: image.data.image_key, name: "image.jpg" }];
  }
  for (const mention of mentions) if (mention.id.open_id === botOpenId) text = text.split(mention.key).join("");
  text = text.trim();
  attachments = attachments.filter((attachment, index) => attachments.findIndex(other => other.key === attachment.key) === index);
  if (!text && !attachments.length || text.length > 12_000 || attachments.length > 4) return null;
  const threadId = message.root_id || message.thread_id;
  const incoming: ChatMessage = {
    platform: "feishu", account: config.appId, id: message.message_id, chatId: message.chat_id,
    senderId, kind: group ? "group" : "direct", text,
    ...(attachments.length ? { attachments } : {}),
    ...(message.parent_id || !group && message.root_id ? { replyToId: message.parent_id || message.root_id } : {}),
    ...(group ? { threadId: threadId || message.message_id } : {}),
  };
  if (group && !mentions.some(mention => mention.id.open_id === botOpenId) && (!threadId || !hasRoute(incoming))) return null;
  return incoming;
}
