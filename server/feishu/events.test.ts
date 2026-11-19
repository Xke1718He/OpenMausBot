import { describe, expect, it } from "vitest";
import { feishuConfigSchema } from "./config.ts";
import { feishuMessage } from "./events.ts";
import { chatRoute } from "../messaging/state.ts";

export const config = feishuConfigSchema.parse({ appId: "cli_0123456789abcdef", botId: "fixture-bot", url: "http://127.0.0.1:8799", allowedUsers: ["ou_alice"], allowedChats: ["oc_group"] });
export function rawMessage(overrides: Record<string, unknown> = {}, sender = "ou_alice") {
  return { sender: { sender_type: "user", sender_id: { open_id: sender } }, message: {
    message_id: "om_first", chat_id: "oc_direct", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: "你好" }), ...overrides,
  } };
}
const mentioned = { chat_type: "group", chat_id: "oc_group", content: JSON.stringify({ text: "@_user_1 查进度" }), mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] };

describe("Feishu inbound messages", () => {
  it("accepts an allowed person's direct chat without a mention", () => {
    expect(feishuMessage(rawMessage(), config, "ou_bot")).toMatchObject({ id: "om_first", kind: "direct", text: "你好", senderId: "ou_alice" });
  });
  it("requires both the exact bot mention and an allowed group", () => {
    expect(feishuMessage(rawMessage(mentioned), config, "ou_bot")).toMatchObject({ kind: "group", text: "查进度", threadId: "om_first" });
    expect(feishuMessage(rawMessage({ ...mentioned, mentions: [] }), config, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage({ ...mentioned, chat_id: "oc_other" }), config, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage(mentioned), config, "ou_other_bot")).toBeNull();
  });
  it("rejects unauthorized people, bots and its own messages", () => {
    expect(feishuMessage(rawMessage({}, "ou_other"), config, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage({}, "ou_alice"), config, "ou_alice")).toBeNull();
    const raw = rawMessage(); raw.sender.sender_type = "bot";
    expect(feishuMessage(raw, config, "ou_bot")).toBeNull();
  });
  it("preserves paragraphs and links in rich-text posts", () => {
    const post = { zh_cn: { title: "报告", content: [[{ tag: "text", text: "结果" }], [{ tag: "a", text: "详情", href: "https://example.test" }]] } };
    expect(feishuMessage(rawMessage({ message_type: "post", content: JSON.stringify(post) }), config, "ou_bot")?.text).toBe("报告\n结果\n详情");
  });
  it.each([
    { content: "not JSON" }, { content: JSON.stringify({ text: " " }) }, { content: JSON.stringify({ text: "x".repeat(12_001) }) },
    { message_type: "file", content: JSON.stringify({ file_key: "file_1" }) }, { message_id: "../bad" }, { chat_type: "unknown" },
  ])("rejects malformed or unsupported messages %#", overrides => {
    expect(feishuMessage(rawMessage(overrides), config, "ou_bot")).toBeNull();
  });
  it("keeps DM, group, app, sender and thread routes apart", () => {
    const direct = feishuMessage(rawMessage(), config, "ou_bot")!;
    const group = feishuMessage(rawMessage({ ...mentioned, root_id: "om_root" }), config, "ou_bot")!;
    expect(new Set([direct, group, { ...direct, senderId: "ou_other" }, { ...group, threadId: "om_other" }, { ...direct, account: "another-app" }].map(chatRoute)).size).toBe(5);
    expect(chatRoute(direct)).toBe(chatRoute({ ...direct, id: "om_followup" }));
    expect(chatRoute(group)).toBe(chatRoute({ ...group, id: "om_followup" }));
  });
  it("does not accept credentials or unknown settings in configuration", () => {
    expect(feishuConfigSchema.safeParse({ ...config, appSecret: "must-not-be-in-config" }).success).toBe(false);
    expect(feishuConfigSchema.safeParse({ ...config, allowedUsers: [] }).success).toBe(false);
    expect(feishuConfigSchema.safeParse({ ...config, publicUrl: "https://user:secret@example.test" }).success).toBe(false);
    expect(feishuConfigSchema.safeParse({ ...config, allowedChats: ["*"] }).success).toBe(false);
  });
});
