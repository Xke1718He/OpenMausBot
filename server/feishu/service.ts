import type { FeishuConnectionInput, FeishuConnectionStatus } from "../../shared/feishu.ts";
import type { SessionRegistry } from "../sessions.ts";
import { FeishuConnectionStore, connectionInputSchema, type FeishuConnectionRecord } from "./connection-store.ts";
import type { FeishuConnectionPhase, RunningFeishuConnection } from "./managed.ts";

export class FeishuServiceError extends Error {
  readonly code: "busy" | "blocked" | "configuration" | "connection";
  constructor(code: FeishuServiceError["code"]) { super("Feishu connection could not be updated"); this.code = code; }
}

export function createFeishuService(deps: {
  store: FeishuConnectionStore;
  sessions: Pick<SessionRegistry, "issue" | "revoke" | "isLive">;
  enabled(): boolean;
  start(record: FeishuConnectionRecord, onState: (state: FeishuConnectionPhase) => void): Promise<RunningFeishuConnection>;
}) {
  let saved: FeishuConnectionRecord | null = null;
  let phase: FeishuConnectionPhase = "not-connected";
  let running: RunningFeishuConnection | undefined;
  let busy = false;
  let closed = false;
  try { saved = deps.store.read(); if (saved) phase = "connecting"; } catch { phase = "error"; }

  const status = (): FeishuConnectionStatus => ({
    state: !deps.enabled() ? "blocked" : saved && !deps.sessions.isLive(saved.sessionId) ? "error" : phase,
    saved: saved !== null, configuration: saved ? { ...saved.configuration } : null,
  });
  const stop = async () => { const previous = running; running = undefined; await previous?.close(); };
  const start = async (record: FeishuConnectionRecord) => {
    if (closed || !deps.enabled() || !deps.sessions.isLive(record.sessionId)) throw new FeishuServiceError("blocked");
    await stop();
    phase = "connecting";
    running = await deps.start(record, next => { if (!closed) phase = next; });
    if (closed) await stop();
  };
  const exclusive = async <T>(action: () => Promise<T>): Promise<T> => {
    if (busy) throw new FeishuServiceError("busy");
    busy = true;
    try { return await action(); } finally { busy = false; }
  };

  return {
    status,
    async restore(): Promise<void> {
      if (!saved || !deps.enabled()) return;
      await exclusive(async () => { try { await start(saved!); } catch { phase = "error"; } });
    },
    connect(input: FeishuConnectionInput, owner: { email?: string; userId?: string }): Promise<FeishuConnectionStatus> {
      return exclusive(async () => {
        if (!deps.enabled() || closed) throw new FeishuServiceError("blocked");
        const parsed = connectionInputSchema.safeParse(input);
        if (!parsed.success) throw new FeishuServiceError("configuration");
        const { appSecret, ...configuration } = parsed.data;
        const secret = appSecret || (saved?.configuration.appId === configuration.appId && saved.configuration.domain === configuration.domain ? saved.appSecret : "");
        if (!secret) throw new FeishuServiceError("configuration");
        const same = saved && saved.configuration.appId === configuration.appId && saved.configuration.botId === configuration.botId && saved.configuration.domain === configuration.domain && deps.sessions.isLive(saved.sessionId);
        const issued = same ? { token: saved!.token, session: { id: saved!.sessionId } } : deps.sessions.issue({ label: "Feishu connector", scopes: ["admin", "client"], ...owner });
        const next: FeishuConnectionRecord = { configuration, appSecret: secret, token: issued.token, sessionId: issued.session.id };
        try {
          await start(next);
          if (closed) throw new FeishuServiceError("blocked");
          deps.store.write(next);
          if (saved && saved.sessionId !== next.sessionId) deps.sessions.revoke(saved.sessionId);
          saved = next;
          return status();
        } catch {
          await stop();
          if (!same) deps.sessions.revoke(next.sessionId);
          phase = "error";
          throw new FeishuServiceError("connection");
        }
      });
    },
    disconnect(): Promise<FeishuConnectionStatus> {
      return exclusive(async () => {
        await stop();
        if (saved) deps.sessions.revoke(saved.sessionId);
        deps.store.clear();
        saved = null; phase = "not-connected";
        return status();
      });
    },
    async close(): Promise<void> { closed = true; await stop(); },
    redact(text: string): string {
      for (const secret of saved ? [saved.appSecret, saved.token] : []) text = text.split(secret).join("[redacted]");
      return text;
    },
  };
}
export type FeishuService = ReturnType<typeof createFeishuService>;
