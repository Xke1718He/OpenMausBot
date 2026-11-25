import { z } from "zod";
import { APPROVAL_MODES } from "../../shared/approval-mode.ts";
import type { RequestAuth } from "../request-auth.ts";
import { attachmentContextSchema } from "./attachment-context.ts";

const id = z.string().regex(/^[\w-]+$/);
export const ownedSendSnapshotSchema = z.object({ activeLeafId: id.nullable(), approvalMode: z.enum(APPROVAL_MODES) });
export const ownedSendSchema = z.object({
  threadId: id, sendId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/), text: z.string().min(1).max(12_000),
  expectedActiveLeafId: id.nullable(), expectedApprovalMode: z.enum(APPROVAL_MODES),
  attachmentContext: attachmentContextSchema.optional(),
}).strict();

// A bot's shell, a script token or an unpaired relay cannot assert a person's request.
export function ownedMessageSession(auth: RequestAuth, enabled: boolean): boolean {
  return enabled && auth.kind === "session" && auth.scopes.includes("admin") &&
    !auth.session.owner && !auth.session.token && !auth.session.moveIn;
}
