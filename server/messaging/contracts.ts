import type { ApprovalMode } from "../../shared/approval-mode.ts";

export interface ChatMessage {
  platform: string;
  account: string;
  id: string;
  chatId: string;
  senderId: string;
  kind: "direct" | "group";
  threadId?: string;
  text: string;
}

export type RunPhase = "working" | "waiting" | "completed" | "failed" | "stopped";

export interface ChatRuntime {
  createConversation(title: string): Promise<string>;
  prepare(threadId: string): Promise<{ activeLeafId: string | null; approvalMode: ApprovalMode }>;
  send(threadId: string, sendId: string, text: string, leaf: string | null, approvalMode?: ApprovalMode): Promise<void>;
  status(threadId: string, sendId: string): Promise<{ phase: RunPhase; text?: string }>;
  stop(threadId: string, sendId: string): Promise<void>;
  conversationUrl(threadId: string): string | undefined;
}

export interface ChatDelivery {
  formatReply?(text: string): string[];
  reply(message: ChatMessage, text: string, deliveryId: string): Promise<void>;
}

export class ChatRuntimeError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.retryable = retryable;
  }
}
