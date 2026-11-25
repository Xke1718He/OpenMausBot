import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { Readable } from "node:stream";

export interface ChatAttachment {
  kind: "file" | "image" | "folder";
  key: string;
  name: string;
  sourcePath?: string;
  batchId?: string;
  bytes?: number;
  sizeChecked?: true;
}

export const MAX_EXPANDED_ATTACHMENTS = 256;
export type ChatResolvedAttachment = ChatAttachment & { kind: "file" | "image" };
export interface ChatAttachmentExpansion { attachments: ChatResolvedAttachment[]; directories: string[] }

export interface ChatDownloadedAttachment {
  stream: Readable;
  mime: string;
  bytes?: number;
  prepare?(maxBytes: number): Promise<{ mime: string; bytes: number }>;
  cancel?(): void | Promise<void>;
  progress?(): { received: number; transferred: number; total?: number };
}

export interface ChatStoredAttachment {
  kind: "file" | "image";
  path: string;
  name: string;
  sourcePath?: string;
  nativePath?: string;
  bytes?: number;
}

export interface ChatMessage {
  platform: string;
  account: string;
  id: string;
  chatId: string;
  senderId: string;
  kind: "direct" | "group";
  threadId?: string;
  replyToId?: string;
  text: string;
  attachments?: ChatAttachment[];
}

export type RunPhase = "working" | "waiting" | "completed" | "failed" | "stopped";

export type ChatTaskAction = "pause" | "resume" | "stop";
export interface ChatTaskControl {
  jobId: string;
  action: ChatTaskAction;
  senderId: string;
  chatId: string;
  messageId: string;
  revision: number;
}
export interface ChatTaskView {
  id: string;
  revision: number;
  phase: RunPhase | "queued" | "downloading" | "submitting" | "paused" | "awaiting_description";
  title: string;
  detail?: string;
  elapsedSeconds: number;
  download?: { name: string; received: number; total?: number; index: number; count: number; bytesPerSecond?: number; etaSeconds?: number; overall?: { received: number; total?: number } };
  url?: string;
}

export interface ChatRuntime {
  createAttachmentDirectory?(batchId: string, directories: string[]): Promise<string>;
  upload?(attachment: ChatAttachment, download: ChatDownloadedAttachment, uploadId: string): Promise<ChatStoredAttachment>;
  createConversation(title: string): Promise<string>;
  prepare(threadId: string): Promise<{ activeLeafId: string | null; approvalMode: ApprovalMode }>;
  checkpoint?(threadId: string, sendId: string): Promise<{ activeLeafId: string | null; approvalMode: ApprovalMode }>;
  send(threadId: string, sendId: string, text: string, leaf: string | null, approvalMode?: ApprovalMode, attachmentContext?: { directory?: string }): Promise<void>;
  status(threadId: string, sendId: string): Promise<{ phase: RunPhase; text?: string; activity?: string }>;
  stop(threadId: string, sendId: string): Promise<void>;
  conversationUrl(threadId: string): string | undefined;
}

export interface ChatDelivery {
  present?(message: ChatMessage, view: ChatTaskView, deliveryId: string, messageId?: string): Promise<string>;
  download?(message: ChatMessage, attachment: ChatAttachment): Promise<ChatDownloadedAttachment>;
  expand?(message: ChatMessage, signal: AbortSignal): Promise<ChatAttachmentExpansion>;
  formatReply?(text: string): string[];
  reply(message: ChatMessage, text: string, deliveryId: string): Promise<void>;
}

export const ATTACHMENT_FAILURES = ["download", "upload", "size", "permission", "network", "storage", "integrity", "range", "cli", "folder"] as const;
export type AttachmentFailure = typeof ATTACHMENT_FAILURES[number];

export function attachmentFailureText(failure: AttachmentFailure): string {
  return {
    download: "附件下载失败，文件可能已删除或当前消息不可访问，请检查后重试。",
    upload: "附件保存失败，请检查文件格式或工作区访问权限后重试。",
    size: "附件超过当前可接收的大小，请减小文件或调整工作区附件存储配额后重试。",
    permission: "飞书拒绝访问附件，请检查应用的消息资源权限、消息可见范围或群防泄密设置。",
    network: "附件传输中断或连接超时，请检查网络后重试。",
    storage: "附件存储空间不足，请清理旧附件或增加工作区附件存储配额后重试。",
    integrity: "附件分片长度或范围不一致，已取消保存，请重新发送文件后重试。",
    range: "飞书未返回有效的分片数据，无法完整下载此文件，请稍后重试。",
    cli: "附件下载需要可用的 lark-cli，请安装或更新官方飞书 CLI 后重试。",
    folder: "目录列表不完整或超过处理范围（最多 256 个文件、32 层目录）。请拆分文件夹或直接发送所需文件后重试。",
  }[failure];
}

export class ChatRuntimeError extends Error {
  readonly retryable: boolean;
  readonly attachmentFailure?: AttachmentFailure;
  constructor(message: string, retryable = false, attachmentFailure?: AttachmentFailure) {
    super(message);
    this.retryable = retryable;
    this.attachmentFailure = attachmentFailure;
  }
}
