import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { decodeCuaConnection, gatedLocalComputer } from "./server/local-computer.ts";

const require = createRequire(import.meta.url);
const { createLinuxCuaRuntime, createLinuxCuaPreferenceStore } = require("./electron/cua-linux-runtime.cjs");
const { createCuaConnectionStore } = require("./electron/cua-connection.cjs");
const { inspectX11Compatibility } = require("./electron/x11-compat.cjs");
const run = promisify(execFile);
const root = mkdtempSync("/tmp/omb-x11-verify-");
const home = path.join(root, "home"), runtimeDirectory = path.join(root, "runtime");
mkdirSync(home, { mode: 0o700 }); mkdirSync(runtimeDirectory, { mode: 0o700 });
const children = [];
function child(command, args, env) {
  const process = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(process); return process;
}
async function poll(read, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    const value = await read().catch(error => { lastError = error; return null; });
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error("Fixture did not reach the expected state");
}

async function devtools(url) {
  const socket = new WebSocket(url), pending = new Map();
  let sequence = 0;
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", event => {
    const frame = JSON.parse(String(event.data));
    const receive = pending.get(frame.id);
    if (receive) { pending.delete(frame.id); receive(frame); }
  });
  return {
    call: (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timed out: ${method}`)); }, 10000);
      pending.set(id, frame => { clearTimeout(timer); if (frame.error) reject(new Error(JSON.stringify(frame.error))); else resolve(frame.result); });
      socket.send(JSON.stringify({ id, method, params }));
    }),
    close: () => socket.close(),
  };
}
let runtime, mcp;
const evidence = [];
try {
  assert.equal(/VERSION_ID="20.04"/.test(readFileSync("/etc/os-release", "utf8")), true);
  const xvfb = child("Xvfb", ["-displayfd", "1", "-screen", "0", "800x600x24", "-nolisten", "tcp"], { PATH: "/usr/bin:/bin", HOME: home });
  let display = "";
  xvfb.stdout.on("data", chunk => { display += chunk; });
  await poll(async () => /^\d+\n/.test(display));
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: home, DISPLAY: `:${display.trim()}`, XDG_RUNTIME_DIR: runtimeDirectory, XDG_SESSION_TYPE: "x11", LANG: "C.UTF-8" };
  child("openbox", ["--sm-disable"], env);
  await poll(async () => /_OB_THEME\(UTF8_STRING\)/.test((await run("xprop", ["-root", "_OB_THEME"], { env })).stdout));
  const eventWindow = child("stdbuf", ["-oL", "xev", "-name", "OpenMausBot isolated input fixture", "-geometry", "320x180+40+40"], env);
  let events = "";
  eventWindow.stdout.on("data", chunk => { events += chunk; });
  const windowId = await poll(async () => {
    const output = (await run("xprop", ["-root", "_NET_CLIENT_LIST_STACKING"], { env })).stdout;
    return Number(/0x[\da-f]+/i.exec(output)?.[0]);
  });
  await run("xprop", ["-id", String(windowId), "-f", "_NET_WM_PID", "32c", "-set", "_NET_WM_PID", String(eventWindow.pid)], { env });
  const helper = "/fixture/helper/openmausbot-x11.cjs";
  assert.equal((await inspectX11Compatibility({ env: { ...env, WAYLAND_DISPLAY: "wayland-0" }, bundledDriverPath: helper })).status, "unavailable");
  createLinuxCuaPreferenceStore({ getUserData: () => home }).write(true);
  runtime = createLinuxCuaRuntime({ backend: "x11-compat", getUserData: () => home,
    connectionStore: createCuaConnectionStore({ getUserData: () => home }), bundledDriverPath: helper, env });
  assert.equal((await runtime.initialize()).status, "disabled");
  assert.equal(existsSync(path.join(home, "x11-local-control.json")), false);
  const ready = await runtime.enable();
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  assert.equal(ready.mode, "linux-x11-compat-supervised");
  const connection = decodeCuaConnection(ready);
  assert.ok(connection);
  assert.equal(gatedLocalComputer(connection, { url: "http://127.0.0.1:1/control", token: "fixture-token" }).env.OMB_CUA_COMMAND, helper);
  assert.equal(decodeCuaConnection({ ...ready, session: "wayland" }), null);
  assert.equal(decodeCuaConnection({ ...ready, mcp: { ...ready.mcp, env: { ...ready.mcp.env, OMB_X11_NODE: "/usr/bin/false" } } }), null);
  assert.equal(decodeCuaConnection({ ...ready, driver: { ...ready.driver, version: "0.41.3" } }), null);
  mcp = child(connection.command, connection.args, { ...env, ...connection.env });
  let counter = 0, buffer = "";
  const requests = new Map();
  mcp.stdout.on("data", chunk => {
    buffer += chunk;
    for (let offset; (offset = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, offset); buffer = buffer.slice(offset + 1);
      const response = JSON.parse(line), waiting = requests.get(response.id);
      if (waiting) { requests.delete(response.id); waiting(response); }
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++counter;
    const timeout = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 15000);
    requests.set(id, response => { clearTimeout(timeout); if (response.error) reject(new Error(response.error.message)); else resolve(response.result); });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
  const call = async (name, args = {}) => {
    const response = await rpc("tools/call", { name, arguments: args });
    evidence.push({ name, error: response.isError ?? false });
    return response;
  };
  assert.ok((await call("list_apps")).structuredContent.apps.some(app => app.pid === eventWindow.pid));
  const capture = await call("get_window_state", { pid: eventWindow.pid, window_id: windowId });
  assert.equal(capture.isError, undefined, JSON.stringify(capture));
  assert.ok(capture.content.some(item => item.type === "image" && Buffer.from(item.data, "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))));
  const target = async () => ({ pid: eventWindow.pid, window_id: windowId,
    snapshot_token: (await call("get_window_state", { pid: eventWindow.pid, window_id: windowId, include_screenshot: false })).structuredContent.snapshot_token });
  const first = await target();
  assert.equal((await call("click", { ...first, x: 20, y: 50 })).isError, undefined);
  assert.equal((await call("click", { ...first, x: 20, y: 50 })).isError, true);
  assert.equal((await call("click", { ...await target(), x: 9999, y: 50 })).isError, true);
  assert.equal((await call("type_text", { ...await target(), text: "fixture" })).isError, undefined);
  assert.equal((await call("press_key", { ...await target(), key: "Return" })).isError, undefined);
  assert.equal((await call("press_key", { ...await target(), key: "ctrl+a;touch /tmp/unsafe" })).isError, true);
  assert.equal((await call("get_window_state", { pid: 1, window_id: windowId })).isError, true);
  await poll(async () => events.includes("ButtonPress event") && events.includes("KeyPress event") && events.includes('"f"'));
  const firstPid = ready.daemon.pid;
  await runtime.disable();
  assert.equal(decodeCuaConnection(ready), null);
  assert.equal(existsSync(ready.daemon.socketPath), false);
  assert.equal(existsSync(`/proc/${firstPid}`), false);
  mcp.stdin.end();
  const restarted = await runtime.enable();
  assert.equal(restarted.status, "ready");
  assert.notEqual(restarted.generation, ready.generation);
  assert.ok(decodeCuaConnection(restarted));
  await runtime.shutdown();
  assert.equal(decodeCuaConnection(restarted), null);
  if (existsSync("/app/openmausbot")) {
    const config = path.join(root, "app-config");
    const bin = path.join(home, ".nvm", "versions", "node", "v24.22.3", "bin");
    const legacy = path.join(root, "legacy-bin"), legacyUsed = path.join(root, "legacy-used"), launches = path.join(root, "codex-launches.ndjson");
    mkdirSync(bin, { recursive: true }); mkdirSync(legacy);
    symlinkSync("/usr/local/bin/node", path.join(bin, "node"));
    writeFileSync(path.join(legacy, "node"), `#!/bin/sh\n: > ${legacyUsed}\nexit 91\n`, { mode: 0o755 });
    writeFileSync(path.join(bin, "package.json"), '{"type":"module"}');
    writeFileSync(path.join(bin, "codex"), `#!/usr/bin/env node\nimport {appendFileSync} from "node:fs";\nappendFileSync(${JSON.stringify(launches)}, JSON.stringify({version:process.version,args:process.argv.slice(2)})+"\\n");\nawait import("file:///fixture/fake-codex.ts");\n`, { mode: 0o755 });
    const stream = path.join(root, "stream.json");
    writeFileSync(stream, JSON.stringify({ OMB_NVM_ICON_CHECK: [{ say: "NVM icon launch fixture completed." }] }));
    mkdirSync(path.join(home, ".openmausbot"), { recursive: true });
    writeFileSync(path.join(home, ".openmausbot", "config.json"), JSON.stringify({ features: { smartSetupChoices: false },
      defaultModelSelection: { instanceId: "codex", model: "gpt-fake-default" },
      instances: { codex: { driver: "codex", displayName: "Icon launch fixture", config: { cli: "codex" },
        environment: { FAKE_STREAM_SCRIPT: stream, FAKE_STREAM_CADENCE: "100:1" } } } }));
    for (const name of ["OpenMausBot", "openmausbot"]) {
      const userData = path.join(config, name);
      mkdirSync(userData, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(userData, "x11-local-control.json"), JSON.stringify({ schemaVersion: 2, linuxLocalControlEnabled: true }), { mode: 0o600 });
    }
    const app = child("/app/openmausbot", ["--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"],
      { ...env, PATH: `${legacy}:/usr/bin:/bin`, XDG_CONFIG_HOME: config, OMB_SMOKE_TEST: "1", OMB_SMOKE_CUA: "0", OMB_SMOKE_KEEP_OPEN: "1" });
    let output = "", errors = "";
    app.stdout.on("data", chunk => { output += chunk; });
    app.stderr.on("data", chunk => { errors += chunk; });
    const rendered = await poll(async () => {
      if (app.exitCode !== null && !output.includes("[smoke] renderer-ready")) throw new Error(`Packaged application exited: ${output}\n${errors}`);
      const result = /\[smoke\] renderer-ready (.+)/.exec(output)?.[1];
      return result ? JSON.parse(result) : null;
    }, 45000);
    assert.equal(rendered.initialCapabilities.localComputer.available, true, JSON.stringify(rendered));
    assert.equal(rendered.health.app, "openmausbot");
    assert.equal(rendered.health.static, true);
    const debugPort = Number(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(errors)?.[1]);
    assert.ok(debugPort, errors);
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = pages.find(page => page.url === rendered.location && page.type === "page");
    assert.ok(page, JSON.stringify(pages));
    const debug = await devtools(page.webSocketDebuggerUrl);
    try {
      const response = await debug.call("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => {
        const api = async (method, url, body) => {
          const response = await fetch(url, { method, headers: {"content-type":"application/json"}, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
          const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
        };
        const {bot} = await api("POST", "/api/bots", {name:"Icon Codex fixture", modelSelection:{instanceId:"codex",model:"gpt-fake-default"}});
        const {task} = await api("POST", "/api/bots/"+bot.id+"/tasks", {});
        await api("POST", "/api/bots/"+bot.id+"/messages", {text:"OMB_NVM_ICON_CHECK",threadId:task.threadId});
        return {botId:bot.id,threadId:task.threadId};
      })()` });
      assert.equal(response.exceptionDetails, undefined, JSON.stringify(response));
      const target = response.result.value;
      await poll(async () => {
        const messages = await debug.call("Runtime.evaluate", { awaitPromise: true, returnByValue: true,
          expression: `fetch(${JSON.stringify(`/api/threads/${target.threadId}/messages?limit=100`)}).then(r=>r.json())` });
        if (!messages.result.value?.messages?.some(message => message.role === "bot" && message.kind === "text" && String(message.text).includes("NVM icon launch fixture completed."))) {
          throw new Error(`Codex fixture has not replied: ${JSON.stringify(messages.result.value).slice(-3000)}`);
        }
        return true;
      }, 30000);
      const records = readFileSync(launches, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.ok(records.some(record => record.args.includes("app-server")));
      assert.ok(records.every(record => record.version.startsWith("v24.")), JSON.stringify(records));
      assert.equal(existsSync(legacyUsed), false);
      evidence.push({ name: "icon-style PATH: Codex completes a turn with its nvm Node", error: false });
      await debug.call("Runtime.evaluate", { expression: "setTimeout(()=>window.close(),0)" });
    } finally { debug.close(); }
    await poll(async () => app.exitCode === 0, 10000);
    evidence.push({ name: "packaged Electron renderer, embedded server and local control", error: false });
  }
  console.log(JSON.stringify({ passed: true, os: "Ubuntu 20.04", isolatedDisplay: env.DISPLAY, windowId, eventWindowPid: eventWindow.pid,
    checks: ["explicit compatibility opt-in", "Wayland refusal", "real descriptor validation", "gated transport wrapping", "screenshots", "mouse and keyboard events", "stale snapshot refusal", "target ownership", "argument validation", "disable", "restart", "parent-owned shutdown"], evidence }));
} finally {
  await runtime?.shutdown();
  for (const process of children.reverse()) { process.stdin?.end(); process.kill("SIGTERM"); }
}
