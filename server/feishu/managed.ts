import { join } from "node:path";
import type { FeishuConnectionStatus } from "../../shared/feishu.ts";
import { OpenMausBotChatRuntime } from "../messaging/openmausbot.ts";
import { chatHash } from "../messaging/state.ts";
import { feishuConfigSchema } from "./config.ts";
import type { FeishuConnectionRecord } from "./connection-store.ts";
import { feishuMessage } from "./events.ts";
import { FeishuTransport } from "./transport.ts";
import { feishuMessageAllowed } from "./access.ts";
import { FeishuBotRouter } from "./bot-router.ts";

export type FeishuConnectionPhase = FeishuConnectionStatus["state"];
export interface RunningFeishuConnection { close(): Promise<void> }

export async function startManagedFeishu(options: {
  record: FeishuConnectionRecord; dataDir: string; url: string; onState: (state: FeishuConnectionPhase) => void;
  transport?: FeishuTransport;
  allowed?: () => boolean;
}): Promise<RunningFeishuConnection> {
  const { record, onState } = options;
  const config = feishuConfigSchema.parse({ ...record.configuration, url: options.url });
  const transport = options.transport ?? new FeishuTransport(config, record.appSecret, () => {}, { onState });
  let bridge: FeishuBotRouter | undefined;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  const close = async () => {
    closed = true;
    if (timer) clearInterval(timer);
    transport.close();
    await active;
    await bridge?.close();
  };
  try {
    const botOpenId = await transport.identity();
    const runtime = new OpenMausBotChatRuntime({ url: options.url, botId: config.botId, token: record.token, downloadDirectory: config.downloadDirectory });
    const environmentId = await runtime.connect();
    const scope = chatHash([environmentId, runtime.origin, config.domain, config.appId, config.botId, record.token]);
    bridge = new FeishuBotRouter({ runtime, transport, defaultBotId: config.botId,
      statePath: join(options.dataDir, `feishu-${scope.slice(0, 16)}.state.json`), scope,
      allowed: message => (!options.allowed || options.allowed()) && feishuMessageAllowed(message, config) });
    const running = bridge;
    onState("connecting");
    await transport.start(async raw => {
      if (closed) throw new Error("Feishu connection is closing");
      const message = feishuMessage(raw, config, botOpenId, message => running.hasRoute(message));
      if (!message) return;
      await running.accept(message);
    }, input => running.control(input), input => running.select(input));
    timer = setInterval(() => {
      if (closed || active) return;
      if (options.allowed && !options.allowed()) { onState("error"); void close(); return; }
      active = Promise.resolve().then(() => { transport.assertConnection(); return running.tick(); })
        .catch(() => { onState("error"); closed = true; if (timer) clearInterval(timer); transport.close(); })
        .finally(() => { active = undefined; });
    }, 1_000);
    timer.unref();
    return { close };
  } catch {
    await close();
    throw new Error("Feishu connection could not be started");
  }
}
