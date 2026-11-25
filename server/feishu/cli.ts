import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { OpenMausBotChatRuntime } from "../messaging/openmausbot.ts";
import { chatHash } from "../messaging/state.ts";
import { readFeishuConfig } from "./config.ts";
import { feishuMessage } from "./events.ts";
import { FeishuTransport } from "./transport.ts";
import { feishuMessageAllowed } from "./access.ts";
import { FeishuBotRouter } from "./bot-router.ts";

export const FEISHU_USAGE = `openmausbot feishu --config FILE [--state FILE] [--check]

Connect a Feishu bot to a running local OpenMausBot workspace.
FILE holds appId, botId, url, allowedUsers and optional allowedChats.
Secrets come from FEISHU_APP_SECRET and OPENMAUSBOT_TOKEN (names can be
changed in FILE). --check validates both connections without starting a listener.
State defaults to FILE.state.json. Keep one bridge per Feishu application.
botId is the default; send /bot in Feishu to choose another workspace bot.
See docs/verification/feishu.md for setup, permissions and session routing.`;

export function acquireBridgeLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch { throw new Error(`Cannot acquire connector lock ${path}; stop the other bridge, or remove its stale lock after confirming it is no longer running`); }
  try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
  let released = false;
  return () => { if (!released) { unlinkSync(path); released = true; } };
}

export async function runFeishuCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let release: (() => void) | undefined;
  let transport: FeishuTransport | undefined;
  let bridge: FeishuBotRouter | undefined;
  const secrets: string[] = [];
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  try {
    const { values } = parseArgs({ args: argv, options: {
      config: { type: "string" }, state: { type: "string" }, check: { type: "boolean" }, help: { type: "boolean", short: "h" },
    }, strict: true, allowPositionals: false });
    if (values.help) { console.log(FEISHU_USAGE); return 0; }
    if (!values.config) { console.error(FEISHU_USAGE); return 2; }
    const file = resolve(values.config);
    const config = readFeishuConfig(file);
    const secret = env[config.appSecretEnv]?.trim(), token = env[config.tokenEnv]?.trim();
    if (!secret || !token) throw new Error(`Set ${config.appSecretEnv} and ${config.tokenEnv} before starting the Feishu connector`);
    secrets.push(secret, token);
    const runtime = new OpenMausBotChatRuntime({ url: config.url, botId: config.botId, token, publicUrl: config.publicUrl, downloadDirectory: config.downloadDirectory });
    const environmentId = await runtime.connect();
    const log = (message: string) => console.error(`[feishu] ${message}`);
    transport = new FeishuTransport(config, secret, log);
    const botOpenId = await transport.identity();
    if (values.check) { log("Configuration, OpenMausBot and Feishu credentials checked"); return 0; }
    const statePath = resolve(values.state ?? `${file}.state.json`);
    release = acquireBridgeLock(`${statePath}.lock`);
    bridge = new FeishuBotRouter({ runtime, transport, defaultBotId: config.botId, statePath,
      scope: chatHash([environmentId, runtime.origin, config.domain, config.appId, config.botId, token]), log, allowed: message => feishuMessageAllowed(message, config) });
    const runningBridge = bridge;
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await transport.start(async raw => {
      const message = feishuMessage(raw, config, botOpenId, message => runningBridge.hasRoute(message));
      if (!message) return;
      await runningBridge.accept(message);
    }, input => runningBridge.control(input), input => runningBridge.select(input));
    log("Listener started; send /bot to choose a bot in private chats or allowed group topics");
    while (!stopped.signal.aborted) {
      transport.assertConnection();
      await bridge.tick();
      await delay(1_000, undefined, { signal: stopped.signal }).catch(() => {});
    }
    return 0;
  } catch (error) {
    let safe = error instanceof Error ? error.message : "Feishu connector failed";
    for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
    console.error(safe);
    return 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    transport?.close();
    await bridge?.close();
    release?.();
  }
}
