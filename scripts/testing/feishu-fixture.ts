import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { launchVerificationServer } from "../control-omb.ts";
import { fixtureApi } from "./preview-fixture.ts";
import { json, readBody } from "../../server/harness/http.ts";
import { FakeFeishu } from "../../server/testing/fake-feishu.ts";
import { FeishuConnectionStore } from "../../server/feishu/connection-store.ts";
import { createFeishuService } from "../../server/feishu/service.ts";
import { createFeishuRoutes } from "../../server/feishu/routes.ts";
import { startManagedFeishu } from "../../server/feishu/managed.ts";
import { feishuConfigSchema } from "../../server/feishu/config.ts";
import type { SessionRegistry } from "../../server/sessions.ts";

export const FEISHU_FIXTURE_SECRET = "fake-feishu-secret";
export async function launchFeishuFixture() {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TOOL_CALLS: "[]", FAKE_CLAUDE_REPLIES: JSON.stringify(Array<string>(4).fill("Feishu fixture answer")) });
  const api = fixtureApi(fixture.info.url, { headers: { origin: fixture.info.url } });
  const platform = new FakeFeishu();
  await platform.listen();
  const issued: ReturnType<SessionRegistry["issue"]>[] = [];
  const live = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const code = await api("POST", "/api/auth/pairing", { label: "Feishu test", scopes: ["admin", "client"] });
    const paired = await api("POST", "/api/auth/pair", { code: code.code, label: "Feishu test" });
    issued.push(paired); live.add(paired.session.id);
  }
  const service = createFeishuService({
    store: new FeishuConnectionStore(fixture.info.dataDir), enabled: () => true,
    sessions: {
      issue: () => { const next = issued.shift(); if (!next) throw new Error("Fixture session pool exhausted"); return next; },
      isLive: id => live.has(id), revoke: id => live.delete(id),
    },
    start: async (record, onState) => {
      if (record.appSecret !== FEISHU_FIXTURE_SECRET) throw new Error("Fixture credentials rejected");
      const config = feishuConfigSchema.parse({ ...record.configuration, url: fixture.info.url });
      const transport = platform.transport(config);
      const running = await startManagedFeishu({ record, onState, url: fixture.info.url, dataDir: fixture.info.dataDir, transport, allowed: () => live.has(record.sessionId) });
      onState("connected");
      return running;
    },
  });
  const route = createFeishuRoutes(service);
  return {
    fixture, api, platform, service,
    route: async (req: IncomingMessage, res: ServerResponse, admin = true) => {
      await route({ req, res, url: new URL(req.url!, fixture.info.url), path: "/api/feishu", method: req.method ?? "GET", auth: { kind: "loopback", scopes: admin ? ["admin", "client"] : ["client"] }, json, readBody });
    },
    async close() { await service.close(); await platform.close(); await fixture.close(); },
    statePath: join(fixture.info.dataDir, "feishu.json.enc"),
  };
}
