import type { ChatMessage } from "../messaging/contracts.ts";
import type { FeishuConfig } from "./config.ts";
import { feishuGroupAccess } from "../../shared/feishu.ts";

export function feishuMessageAllowed(
  message: Pick<ChatMessage, "kind" | "chatId" | "senderId">,
  config: Pick<FeishuConfig, "allowedUsers" | "allowedChats" | "groupAccess" | "groupAccessByChat">,
): boolean {
  const listedUser = config.allowedUsers.includes(message.senderId);
  return message.kind === "direct" ? listedUser
    : config.allowedChats.includes(message.chatId) && (feishuGroupAccess(config, message.chatId) === "everyone" || listedUser);
}
