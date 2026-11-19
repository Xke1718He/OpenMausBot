/** Configuration entered on the Feishu card. Secret values are accepted only on writes and never returned. */
export interface FeishuConnectionInput {
  appId: string;
  appSecret?: string;
  botId: string;
  domain: "feishu" | "lark";
  allowedUsers: string[];
  allowedChats: string[];
}

/** GET /api/feishu. The saved application secret and internal session token are never exposed. */
export interface FeishuConnectionStatus {
  state: "not-connected" | "connecting" | "connected" | "reconnecting" | "error" | "blocked";
  saved: boolean;
  configuration: Omit<FeishuConnectionInput, "appSecret"> | null;
}

export const FEISHU_SEARCH = "飞书 feishu lark larksuite messaging chat 消息 通讯";
export const FEISHU_CATALOG_CARD = { slug: "feishu", categories: ["Communication"] };
