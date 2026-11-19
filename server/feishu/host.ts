import type { SessionRegistry } from "../sessions.ts";
import { FeishuConnectionStore } from "./connection-store.ts";
import { startManagedFeishu } from "./managed.ts";
import { createFeishuRoutes } from "./routes.ts";
import { createFeishuService } from "./service.ts";

export function createFeishuHost(options: { dataDir: string; port: number; sessions: SessionRegistry; enabled(): boolean }) {
  const service = createFeishuService({
    store: new FeishuConnectionStore(options.dataDir), sessions: options.sessions, enabled: options.enabled,
    start: (record, onState) => startManagedFeishu({ record, onState, dataDir: options.dataDir, url: `http://127.0.0.1:${options.port}`, allowed: () => options.enabled() && options.sessions.isLive(record.sessionId) }),
  });
  return { ...service, routes: createFeishuRoutes(service) };
}
