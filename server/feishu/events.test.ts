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
  it("distinguishes a reply target from the shared topic root", () => {
    const topic = { chat_type: "group", chat_id: "oc_group", root_id: "om_topic" };
    expect(feishuMessage(rawMessage(topic), config, "ou_bot", () => true)?.replyToId).toBeUndefined();
    expect(feishuMessage(rawMessage({ ...topic, parent_id: "om_file" }), config, "ou_bot", () => true)?.replyToId).toBe("om_file");
  });
  it("admits folder messages without bypassing private-user or group-topic access", () => {
    const folder = { message_type: "folder", content: JSON.stringify({ file_key: "file_folder", file_name: "rosbag" }) };
    expect(feishuMessage(rawMessage(folder), config, "ou_bot")?.attachments).toEqual([{ kind: "folder", key: "file_folder", name: "rosbag" }]);
    expect(feishuMessage(rawMessage(folder, "ou_stranger"), config, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage({ ...folder, chat_type: "group", chat_id: "oc_group" }), config, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage({ ...folder, chat_type: "group", chat_id: "oc_group", root_id: "om_topic" }), config, "ou_bot", () => true)?.attachments?.[0]?.kind).toBe("folder");
  });
  it("accepts an allowed person's direct chat without a mention", () => {
    expect(feishuMessage(rawMessage(), config, "ou_bot")).toMatchObject({ id: "om_first", kind: "direct", text: "你好", senderId: "ou_alice" });
  });
  it("requires both the exact bot mention and an allowed group", () => {
    expect(feishuMessage(rawMessage(mentioned), config, "ou_bot")).toMatchObject({ kind: "group", text: "查进度", threadId: "om_first" });
    expect(feishuMessage(rawMessage({ ...mentioned, mentions: [] }), config, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage({ ...mentioned, chat_id: "oc_other" }), config, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage(mentioned), config, "ou_other_bot")).toBeNull();
  });
  it("accepts unmentioned replies only within a known group topic", () => {
    const first = feishuMessage(rawMessage(mentioned), config, "ou_bot")!;
    const hasRoute = (message: Parameters<typeof chatRoute>[0]) => chatRoute(message) === chatRoute(first);
    const reply = { ...mentioned, message_id: "om_followup", mentions: [], content: JSON.stringify({ text: "继续" }), root_id: first.id };
    expect(feishuMessage(rawMessage(reply), config, "ou_bot", hasRoute)).toMatchObject({ text: "继续", threadId: first.id });
    expect(feishuMessage(rawMessage({ ...reply, root_id: undefined, thread_id: first.id }), config, "ou_bot", hasRoute)).toMatchObject({ threadId: first.id });
    expect(feishuMessage(rawMessage(reply), config, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage({ ...reply, root_id: "om_unrelated" }), config, "ou_bot", hasRoute)).toBeNull();
    expect(feishuMessage(rawMessage({ ...reply, root_id: undefined }), config, "ou_bot", () => true)).toBeNull();
    expect(feishuMessage(rawMessage({ ...reply, chat_id: "oc_other" }), config, "ou_bot", () => true)).toBeNull();
    expect(feishuMessage(rawMessage(reply, "ou_other"), config, "ou_bot", () => true)).toBeNull();
    const botReply = rawMessage(reply); botReply.sender.sender_type = "bot";
    expect(feishuMessage(botReply, config, "ou_bot", () => true)).toBeNull();
  });
  it("rejects unauthorized people, bots and its own messages", () => {
    expect(feishuMessage(rawMessage({}, "ou_other"), config, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage({}, "ou_alice"), config, "ou_alice")).toBeNull();
    const raw = rawMessage(); raw.sender.sender_type = "bot";
    expect(feishuMessage(raw, config, "ou_bot")).toBeNull();
  });
  it("admits all human members of listed groups only when everyone mode is selected", () => {
    const everyone = { ...config, groupAccess: "everyone" as const, allowedUsers: [] };
    const first = feishuMessage(rawMessage(mentioned, "ou_guest"), everyone, "ou_bot");
    expect(first).toMatchObject({ senderId: "ou_guest", kind: "group" });
    expect(feishuMessage(rawMessage({ ...mentioned, root_id: "om_first", mentions: [] }, "ou_another"), everyone, "ou_bot", () => true))
      .toMatchObject({ senderId: "ou_another", threadId: "om_first" });
    expect(feishuMessage(rawMessage({}, "ou_guest"), everyone, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage({ ...mentioned, chat_id: "oc_other" }, "ou_guest"), everyone, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage({ ...mentioned, mentions: [] }, "ou_guest"), everyone, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage(mentioned, "ou_guest"), { ...everyone, groupAccess: "allowlist" }, "ou_bot")).toBeNull();
    const bot = rawMessage(mentioned); bot.sender.sender_type = "bot";
    expect(feishuMessage(bot, everyone, "ou_bot")).toBeNull();
  });
  it("applies each group's access mode independently, including an explicit restriction over a fallback", () => {
    const scoped = { ...config, allowedChats: ["oc_group", "oc_restricted"], groupAccess: "everyone" as const,
      groupAccessByChat: { oc_group: "everyone" as const, oc_restricted: "allowlist" as const } };
    expect(feishuMessage(rawMessage(mentioned, "ou_guest"), scoped, "ou_bot")).toMatchObject({ senderId: "ou_guest" });
    expect(feishuMessage(rawMessage({ ...mentioned, chat_id: "oc_restricted" }, "ou_guest"), scoped, "ou_bot")).toBeNull();
    expect(feishuMessage(rawMessage({ ...mentioned, chat_id: "oc_restricted" }), scoped, "ou_bot")).toMatchObject({ senderId: "ou_alice" });
    expect(feishuMessage(rawMessage({}, "ou_guest"), scoped, "ou_bot")).toBeNull();
  });
  it("preserves paragraphs and links in rich-text posts", () => {
    const post = { zh_cn: { title: "报告", content: [[{ tag: "text", text: "结果" }], [{ tag: "a", text: "详情", href: "https://example.test" }]] } };
    expect(feishuMessage(rawMessage({ message_type: "post", content: JSON.stringify(post) }), config, "ou_bot")?.text).toBe("报告\n结果\n详情");
  });
  it("preserves file and image references and accepts attachments inside an admitted group topic", () => {
    const file = { message_type: "file", content: JSON.stringify({ file_key: "file_v3_fixture", file_name: "Report & notes.pdf" }) };
    expect(feishuMessage(rawMessage(file), config, "ou_bot")).toMatchObject({
      text: "", attachments: [{ kind: "file", key: "file_v3_fixture", name: "Report & notes.pdf" }],
    });
    expect(feishuMessage(rawMessage({ ...file, chat_type: "group", chat_id: "oc_group", root_id: "om_topic" }), config, "ou_bot", () => true)?.attachments).toHaveLength(1);
    expect(feishuMessage(rawMessage({ ...file, chat_type: "group", chat_id: "oc_group" }), config, "ou_bot", () => true)).toBeNull();
    const post = { zh_cn: { content: [[{ tag: "text", text: "Read this" }, { tag: "img", image_key: "img_v3_fixture" }]] } };
    expect(feishuMessage(rawMessage({ message_type: "post", content: JSON.stringify(post) }), config, "ou_bot"))
      .toMatchObject({ text: "Read this", attachments: [{ kind: "image", key: "img_v3_fixture" }] });
    expect(feishuMessage(rawMessage({ message_type: "image", content: JSON.stringify({ image_key: "img_v3_fixture" }) }), config, "ou_bot")?.attachments).toHaveLength(1);
    expect(feishuMessage(rawMessage({ ...file, content: JSON.stringify({ file_key: "../../private", file_name: "Report.pdf" }) }), config, "ou_bot")).toBeNull();
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
    expect(feishuConfigSchema.safeParse({ ...config, allowedUsers: [], groupAccess: "everyone" }).success).toBe(true);
    expect(feishuConfigSchema.safeParse({ ...config, groupAccess: "unknown" }).success).toBe(false);
    expect(feishuConfigSchema.safeParse({ ...config, groupAccessByChat: { oc_group: "everyone" } }).success).toBe(true);
    expect(feishuConfigSchema.safeParse({ ...config, groupAccessByChat: { "*": "everyone" } }).success).toBe(false);
    expect(feishuConfigSchema.safeParse({ ...config, groupAccessByChat: { oc_group: "unknown" } }).success).toBe(false);
    expect(feishuConfigSchema.safeParse({ ...config, publicUrl: "https://user:secret@example.test" }).success).toBe(false);
    expect(feishuConfigSchema.safeParse({ ...config, allowedChats: ["*"] }).success).toBe(false);
  });
});
