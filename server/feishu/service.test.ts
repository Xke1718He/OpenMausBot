import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry } from "../sessions.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { excludedWorkspaceAuthPath } from "../workspace-backup-policy.ts";
import { FeishuConnectionStore } from "./connection-store.ts";
import { createFeishuService } from "./service.ts";

const dirs: string[] = [];
const services: ReturnType<typeof createFeishuService>[] = [];
const configuration = { appId: "cli_0123456789abcdef", botId: "bot", domain: "feishu" as const, allowedUsers: ["ou_owner"], allowedChats: [] };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-feishu-service-")); dirs.push(dir);
  const store = new FeishuConnectionStore(dir);
  const sessions = new SessionRegistry({ file: join(dir, "sessions.json"), emailScopes: () => ["admin", "client"] });
  const close = vi.fn(async () => {});
  let enabled = true;
  const start = vi.fn(async (_record, onState) => { onState("connected"); return { close }; });
  const service = createFeishuService({ store, sessions, enabled: () => enabled, start }); services.push(service);
  return { dir, store, sessions, close, start, service, disable: () => { enabled = false; } };
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

describe("managed Feishu connection", () => {
  it("seals secrets, exposes configuration only, and excludes credentials and pending work from backups", async () => {
    const fx = fixture();
    const status = await fx.service.connect({ ...configuration, appSecret: "feishu-test-secret" }, { email: "owner@example.test", userId: "fixture-owner" });
    expect(status).toEqual({ state: "connected", saved: true, configuration });
    const record = fx.store.read()!;
    expect(record.appSecret).toBe("feishu-test-secret");
    expect(record.token).toMatch(/^omb_sess_/);
    expect(fx.sessions.authenticate(record.token)).toMatchObject({ email: "owner@example.test", userId: "fixture-owner", scopes: ["admin", "client"] });
    expect(JSON.stringify(status)).not.toContain(record.token);
    expect(fx.service.redact(`a ${record.token} b ${record.appSecret}`)).toBe("a [redacted] b [redacted]");
    for (const file of readdirSync(fx.dir).filter(name => name.startsWith("feishu"))) {
      expect(readFileSync(join(fx.dir, file)).includes(Buffer.from("feishu-test-secret"))).toBe(false);
      expect(excludedWorkspaceAuthPath(file)).toBe(true);
    }
    expect(excludedWorkspaceAuthPath("feishu-0123456789abcdef.state.json")).toBe(true);
    expect(excludedWorkspaceAuthPath("attachments/feishu-key")).toBe(false);
    fx.sessions.close();
  });
  it("keeps the saved secret and session when editing an existing app", async () => {
    const fx = fixture();
    await fx.service.connect({ ...configuration, appSecret: "saved-secret" }, {});
    const sessionId = fx.store.read()!.sessionId;
    await fx.service.connect({ ...configuration, allowedChats: ["oc_group"] }, {});
    expect(fx.close).toHaveBeenCalledTimes(1);
    expect(fx.store.read()!.appSecret).toBe("saved-secret");
    expect(fx.store.read()!.sessionId).toBe(sessionId);
    await expect(fx.service.connect({ ...configuration, appId: "cli_fedcba9876543210" }, {})).rejects.toMatchObject({ code: "configuration" });
    fx.sessions.close();
  });
  it("revokes the service session and forgets credentials on disconnect", async () => {
    const fx = fixture(); await fx.service.connect({ ...configuration, appSecret: "secret" }, {});
    const saved = fx.store.read()!;
    expect(fx.sessions.isLive(saved.sessionId)).toBe(true);
    expect(await fx.service.disconnect()).toEqual({ state: "not-connected", saved: false, configuration: null });
    expect(fx.sessions.isLive(saved.sessionId)).toBe(false);
    expect(fx.store.read()).toBeNull();
    expect(fx.close).toHaveBeenCalledTimes(1); fx.sessions.close();
  });
  it("saves nothing and revokes the new session when credentials or startup are refused", async () => {
    const fx = fixture(); fx.start.mockRejectedValue(new Error("vendor output must stay private"));
    await expect(fx.service.connect({ ...configuration, appSecret: "bad-secret" }, {})).rejects.toMatchObject({ code: "connection" });
    expect(fx.store.read()).toBeNull();
    expect(fx.sessions.list()).toHaveLength(0); fx.sessions.close();
  });
  it("restores a saved connection and refuses use in an unsupported workspace", async () => {
    const fx = fixture(); await fx.service.connect({ ...configuration, appSecret: "secret" }, {});
    await fx.service.close();
    const restarted = createFeishuService({ store: fx.store, sessions: fx.sessions, enabled: () => true, start: fx.start }); services.push(restarted);
    await restarted.restore(); expect(restarted.status().state).toBe("connected");
    fx.disable(); expect(fx.service.status().state).toBe("blocked");
    await expect(fx.service.connect({ ...configuration, appSecret: "secret" }, {})).rejects.toMatchObject({ code: "blocked" }); fx.sessions.close();
  });
});
