import { z } from "zod";

export const BOT_PAGE_SIZE = 8;
export interface FeishuBotChoice { id: string; name: string; title?: string; description?: string }
const plain = (content: string) => ({ tag: "plain_text", content });
const summary = (value: string | undefined, limit: number) => {
  const characters = Array.from((value ?? "").replace(/\s+/g, " ").trim());
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : characters.join("");
};
const responsibilities = (bot: FeishuBotChoice) => [summary(bot.title, 120), summary(bot.description, 240)].filter(Boolean).join("\n") || "尚未填写职责介绍";
const valueSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("select_bot"), menuId: z.string().regex(/^[a-f0-9]{64}$/), botId: z.string().regex(/^[\w-]+$/) }).strict(),
  z.object({ action: z.literal("bot_page"), menuId: z.string().regex(/^[a-f0-9]{64}$/), page: z.number().int().nonnegative() }).strict(),
]);
export type FeishuBotAction = z.infer<typeof valueSchema> & { senderId: string; chatId: string; messageId: string };
export interface FeishuBotActionResult { text: string; card: ReturnType<typeof feishuBotCard> }

export function feishuBotAction(raw: unknown): FeishuBotAction | null {
  const result = z.object({
    operator: z.object({ open_id: z.string().regex(/^ou_[\w-]+$/) }),
    context: z.object({ open_message_id: z.string().regex(/^om_[\w-]+$/), open_chat_id: z.string().regex(/^oc_[\w-]+$/) }),
    action: z.object({ tag: z.literal("button"), value: valueSchema }),
  }).safeParse(raw);
  if (!result.success) return null;
  const { operator, context, action } = result.data;
  return { ...action.value, senderId: operator.open_id, chatId: context.open_chat_id, messageId: context.open_message_id };
}

export function feishuBotCard(menuId: string, bots: FeishuBotChoice[], currentBotId: string, page = 0, selected = false) {
  const current = bots.find(bot => bot.id === currentBotId);
  const elements: Record<string, unknown>[] = [{ tag: "div", text: plain(`当前 bot：${current?.name ?? "不可用"}`) }];
  const button = (text: string, value: z.infer<typeof valueSchema>, primary = false) => ({ tag: "button", text: plain(text), type: primary ? "primary_filled" : "default", behaviors: [{ type: "callback", value }] });
  if (!selected) {
    for (const bot of bots.slice(page * BOT_PAGE_SIZE, (page + 1) * BOT_PAGE_SIZE)) elements.push({
      tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "weighted", weight: 1, elements: [
        button(`${bot.name.slice(0, 60)}${bot.id === currentBotId ? "（当前）" : ""}`, { action: "select_bot", menuId, botId: bot.id }, bot.id === currentBotId),
        { tag: "div", text: plain(responsibilities(bot)) },
      ] }],
    });
    const pages = Math.ceil(bots.length / BOT_PAGE_SIZE);
    const navigation = [
      ...(page > 0 ? [button("上一页", { action: "bot_page", menuId, page: page - 1 })] : []),
      ...(page + 1 < pages ? [button("下一页", { action: "bot_page", menuId, page: page + 1 })] : []),
    ];
    if (navigation.length) elements.push({ tag: "column_set", flex_mode: "none", columns: navigation.map(item => ({ tag: "column", width: "weighted", weight: 1, elements: [item] })) });
    elements.push({ tag: "div", text: plain(bots.length ? `仅发起人可选择。${pages > 1 ? `第 ${page + 1}/${pages} 页。` : ""}选择后，后续消息将直接发给该 bot；切回时继续原会话。群聊中的选择仅对你在当前话题内生效。` : "暂无可用 bot，请在 OpenMausBot 中创建后重新发送 /bot。") });
  } else {
    if (current) elements.push({ tag: "div", text: plain(responsibilities(current)) });
    elements.push({ tag: "div", text: plain("已切换，后续消息将直接发给此 bot。发送 /bot 可再次切换。") });
  }
  return { schema: "2.0", config: { update_multi: true, enable_forward: false }, header: { title: plain(selected ? "已切换 bot" : "选择 bot"), template: "blue" }, body: { elements } };
}
