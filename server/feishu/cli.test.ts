import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { acquireBridgeLock, runFeishuCli } from "./cli.ts";
import { readFeishuConfig } from "./config.ts";

const dirs: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), "omb-feishu-cli-")); dirs.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await removeTempDir(dir); });

it("takes an exclusive process lock and releases it once", () => {
  const path = join(root(), "state.lock");
  const release = acquireBridgeLock(path);
  expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  expect(() => acquireBridgeLock(path)).toThrow(/lock/);
  release(); release();
  acquireBridgeLock(path)();
});

it("provides help and rejects unknown flags without reaching any server", async () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fetcher = vi.spyOn(globalThis, "fetch");
  expect(await runFeishuCli(["--help"], {})).toBe(0);
  expect(out).toHaveBeenCalledWith(expect.stringContaining("--config"));
  expect(await runFeishuCli([], {})).toBe(2);
  expect(await runFeishuCli(["--token", "never-put-secrets-in-argv"], {})).toBe(1);
  expect(fetcher).not.toHaveBeenCalled();
});

it("reports configuration field names without echoing unknown secret values", () => {
  const file = join(root(), "config.json");
  writeFileSync(file, JSON.stringify({ appSecret: "do-not-echo" }));
  expect(() => readFeishuConfig(file)).toThrow(/appId/);
  expect(() => readFeishuConfig(file)).not.toThrow(/do-not-echo/);
});
