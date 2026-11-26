const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { createTools, tools } = require("./tools.cjs");

const VERSION = "1.0.0";
const HOST = "com.openmausbot.app";
const PROTOCOL = "2025-06-18";
const MAX_FRAME = 128 * 1024;
const command = process.argv[2];
const args = process.argv.slice(3);
const value = key => args[args.indexOf(key) + 1];

function privateSocket(socketPath) {
  if (!path.isAbsolute(socketPath ?? "") || Buffer.byteLength(socketPath) > 100) throw new Error("Invalid private socket path");
  const directory = fs.lstatSync(path.dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o077)) throw new Error("Socket directory must be private and owned by this user");
}

function doctor() {
  const x11 = ["x11", "xorg"].includes(String(process.env.XDG_SESSION_TYPE).toLowerCase()) && !process.env.WAYLAND_DISPLAY && /^:\d+(?:\.\d+)?$/.test(process.env.DISPLAY ?? "");
  const probes = [{ label: "session", status: x11 ? "ok" : "err", message: x11 ? "Local X11 session" : "Local control requires a local Xorg session" }];
  for (const name of ["xdotool", "xprop", "xwd"]) {
    let trusted = false;
    try {
      const file = fs.statSync(`/usr/bin/${name}`);
      trusted = file.isFile() && file.uid === 0 && (file.mode & 0o111) !== 0 && (file.mode & 0o022) === 0;
    } catch { }
    probes.push({ label: name, status: trusted ? "ok" : "err", message: trusted ? "Available" : "Install xdotool, x11-utils and x11-apps using the system package manager" });
  }
  return { ok: probes.every(probe => probe.status === "ok"), probes };
}

function frames(stream, receive, failed) {
  let buffer = Buffer.alloc(0);
  stream.on("data", chunk => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (buffer.length > MAX_FRAME) { failed(); return; }
    for (let offset; (offset = buffer.indexOf(10)) >= 0;) {
      const line = buffer.subarray(0, offset); buffer = buffer.subarray(offset + 1);
      try { receive(JSON.parse(line.toString("utf8"))); } catch { failed(); return; }
    }
  });
}

function request(socketPath, frame, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0), settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const cancel = () => done(new Error("Computer operation cancelled"));
    const timer = setTimeout(() => done(new Error("Computer operation timed out")), 15000);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    socket.once("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 10 * 1024 * 1024) { done(new Error("Computer response is too large")); return; }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        done(response.ok ? null : new Error("Computer helper refused the request"), response.result);
      } catch { done(new Error("Invalid computer response")); }
    });
    socket.once("error", () => done(new Error("Computer helper is unavailable")));
    socket.once("close", () => { if (!settled) done(new Error("Computer helper stopped")); });
  });
}

function serve(socketPath, pidFile) {
  privateSocket(socketPath);
  if (pidFile !== path.join(path.dirname(socketPath), "driver.pid") || !doctor().ok || !args.includes("--embedded") ||
      !args.includes("--no-overlay") || value("--permission-mode") !== "standard" ||
      process.env.OMB_X11_EMBEDDED !== "1" || process.env.OMB_X11_HOST_BUNDLE_ID !== HOST ||
      process.env.OMB_X11_PARENT_LIVENESS_STDIN !== "1") throw new Error("Invalid supervised X11 runtime");
  const call = createTools(), pending = new Set(), sockets = new Set();
  let queue = Promise.resolve(), closing = false;
  const metadata = { driver_version: VERSION, contract_version: "0.8.0", tools_list_schema_version: "1", capability_version: "1", mcp_protocol_version: PROTOCOL, embedded: true, host_bundle_id: HOST, pid: process.pid };
  const server = net.createServer(socket => {
    if (closing || sockets.size >= 64) { socket.destroy(); return; }
    sockets.add(socket);
    const abort = new AbortController();
    pending.add(abort);
    socket.once("close", () => { abort.abort(); pending.delete(abort); sockets.delete(socket); });
    socket.on("error", () => socket.destroy());
    let received = false;
    frames(socket, frame => {
      if (received || closing) { socket.destroy(); return; }
      received = true;
      const answer = result => { if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: true, result })}\n`); };
      if (frame.method === "metadata") { answer(metadata); return; }
      if (frame.method === "list") { answer({ schema_version: "1", capability_version: "1", tools }); return; }
      if (frame.method !== "call") { socket.destroy(); return; }
      queue = queue.then(async () => {
        if (abort.signal.aborted || closing) return;
        try { answer(await call(frame.name, frame.args, abort.signal)); }
        catch (error) { answer({ isError: true, content: [{ type: "text", text: error.message }] }); }
      }).catch(() => socket.destroy());
    }, () => socket.destroy());
  });
  const stop = () => {
    if (closing) return;
    closing = true;
    for (const abort of pending) abort.abort();
    for (const socket of sockets) socket.destroy();
    server.close();
    for (const file of [socketPath, pidFile]) { try { fs.unlinkSync(file); } catch { } }
    process.stdin.destroy();
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.stdin.resume(); process.stdin.once("end", stop);
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  server.on("error", () => { process.exitCode = 1; stop(); });
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o600);
    fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600, flag: "wx" });
  });
}

function mcp(socketPath) {
  privateSocket(socketPath);
  const file = fs.lstatSync(socketPath);
  if (!file.isSocket() || file.isSymbolicLink() || file.uid !== process.getuid() || (file.mode & 0o077)) throw new Error("Invalid private computer socket");
  const active = new Map();
  const stop = () => { for (const abort of active.values()) abort.abort(); process.stdin.destroy(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop); process.stdin.once("end", stop);
  frames(process.stdin, frame => {
    if (frame.method === "notifications/cancelled") { active.get(frame.params?.requestId)?.abort(); return; }
    if (!Object.hasOwn(frame, "id")) return;
    if (active.has(frame.id)) { stop(); return; }
    const abort = new AbortController(); active.set(frame.id, abort);
    const response = async () => {
      if (frame.method === "initialize") return { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "openmausbot-x11", version: VERSION } };
      if (frame.method === "ping") return {};
      if (frame.method === "tools/list") return { tools: (await request(socketPath, { method: "list" }, abort.signal)).tools };
      if (frame.method === "tools/call") return request(socketPath, { method: "call", name: frame.params?.name, args: frame.params?.arguments ?? {} }, abort.signal);
      throw new Error("Unsupported computer method");
    };
    void response().then(result => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`))
      .catch(error => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32000, message: error.message } })}\n`))
      .finally(() => active.delete(frame.id));
  }, stop);
}

try {
  if (command === "--version") console.log(`openmausbot-x11 ${VERSION}`);
  else if (command === "manifest") console.log(JSON.stringify({ schema_version: "1", backend: "openmausbot-x11", binary_version: VERSION, mcp_invocation: { command: fs.realpathSync(process.argv[1]), args: ["mcp"] } }));
  else if (command === "doctor") { const report = doctor(); console.log(JSON.stringify(report)); process.exitCode = report.ok ? 0 : 1; }
  else if (command === "serve") serve(value("--socket"), value("--pid-file"));
  else if (command === "mcp" && args.includes("--embedded")) mcp(value("--socket"));
  else throw new Error("Unsupported X11 helper invocation");
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
