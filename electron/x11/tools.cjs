const { execFile } = require("node:child_process");
const { statSync, readFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { xwdToPng } = require("./screenshot.cjs");

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const integer = { type: "integer", minimum: 1, maximum: 0xffffffff };
const target = { pid: integer, window_id: integer };
const action = { ...target, snapshot_token: { type: "string" } };
const tools = [
  { name: "list_apps", description: "List this user's visible X11 application windows.", inputSchema: object({}) },
  { name: "list_windows", description: "List visible X11 windows, optionally belonging to a process.", inputSchema: object({ pid: integer }) },
  { name: "get_window_state", description: "Read an X11 window and optionally its screenshot. This backend provides pixels, not an accessibility tree. Refresh before every action to get a snapshot_token and window-relative coordinates.", inputSchema: object({ ...target, include_screenshot: { type: "boolean", default: true } }, ["pid", "window_id"]) },
  { name: "click", description: "Click on the shared X11 desktop using coordinates relative to the captured window. Activates that window and moves the person's pointer.", inputSchema: object({ ...action, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, button: { type: "string", enum: ["left", "middle", "right"], default: "left" }, click_count: { type: "integer", minimum: 1, maximum: 2 } }, ["pid", "window_id", "snapshot_token", "x", "y"]) },
  { name: "move_cursor", description: "Move the shared X11 pointer inside a freshly captured window.", inputSchema: object({ ...action, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 } }, ["pid", "window_id", "snapshot_token", "x", "y"]) },
  { name: "type_text", description: "Type UTF-8 text into the freshly captured window using the shared keyboard. Activates the window; no background input is supported.", inputSchema: object({ ...action, text: { type: "string", minLength: 1, maxLength: 12000 } }, ["pid", "window_id", "snapshot_token", "text"]) },
  { name: "press_key", description: "Press an X11 key or shortcut, such as Return, Tab, Escape or ctrl+a, in the captured window.", inputSchema: object({ ...action, key: { type: "string", minLength: 1, maxLength: 80 } }, ["pid", "window_id", "snapshot_token", "key"]) },
  { name: "scroll", description: "Scroll inside the captured window on the shared X11 desktop.", inputSchema: object({ ...action, x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 }, direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: 40 } }, ["pid", "window_id", "snapshot_token", "x", "y", "direction"]) },
];

function validate(name, args) {
  const schema = tools.find(tool => tool.name === name)?.inputSchema;
  if (!schema || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Unknown tool or invalid arguments");
  if (schema.required.some(key => !Object.hasOwn(args, key))) throw new Error("Missing required arguments");
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (!field || field.enum && !field.enum.includes(value) ||
        field.type === "integer" && (!Number.isSafeInteger(value) || value < (field.minimum ?? 0) || value > (field.maximum ?? 0xffffffff)) ||
        field.type === "string" && (typeof value !== "string" || value.includes("\0") || value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? 128)) ||
        field.type === "boolean" && typeof value !== "boolean") throw new Error(`Invalid ${key}`);
  }
  if (name === "press_key" && !/^(?:[A-Za-z0-9_]+\+)*[A-Za-z0-9_]+$/.test(args.key)) throw new Error("Unsupported keyboard shortcut");
}

function run(tool, args, signal, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(`/usr/bin/${tool}`, args, { signal, timeout: 5000, maxBuffer: tool === "xwd" ? 72 * 1024 * 1024 : 256 * 1024,
      encoding: tool === "xwd" ? "buffer" : "utf8", env: { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY, HOME: process.env.HOME, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } },
    (error, stdout) => error ? reject(new Error(signal?.aborted ? "Computer operation cancelled" : `${tool} could not complete the requested operation`)) : resolve(stdout));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function processIdentity(pid) {
  if (statSync(`/proc/${pid}`).uid !== process.getuid()) throw new Error("Window is not owned by this user");
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

async function windowState(id, signal) {
  const properties = await run("xprop", ["-id", String(id), "_NET_WM_PID", "_NET_WM_NAME", "WM_NAME", "WM_CLASS"], signal);
  const pid = Number(/_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(properties)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Window has no verifiable owning process");
  const processStart = processIdentity(pid);
  const geometry = await run("xdotool", ["getwindowgeometry", "--shell", String(id)], signal);
  const values = Object.fromEntries([...geometry.matchAll(/^([A-Z]+)=(-?\d+)$/gm)].map(match => [match[1], Number(match[2])]));
  if (![values.X, values.Y, values.WIDTH, values.HEIGHT].every(Number.isSafeInteger) || values.WIDTH <= 0 || values.HEIGHT <= 0) throw new Error("Window geometry is unavailable");
  const title = /(?:_NET_WM_NAME\(UTF8_STRING\)|WM_NAME\(STRING\)) = (".*")/.exec(properties)?.[1];
  let name = "Untitled window";
  if (title) { try { name = JSON.parse(title).slice(0, 200); } catch { name = title.slice(1, -1).slice(0, 200); } }
  return { pid, window_id: id, title: name, process_start: processStart, bounds: { x: values.X, y: values.Y, width: values.WIDTH, height: values.HEIGHT } };
}

const textResult = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
function createTools() {
  const snapshots = new Map();
  async function list(signal) {
    const result = await run("xprop", ["-root", "_NET_CLIENT_LIST_STACKING"], signal);
    const ids = [...result.matchAll(/0x[\da-f]+/gi)].map(match => Number(match[0]));
    const windows = [];
    for (const id of ids.slice(-100)) {
      if (signal.aborted) throw new Error("Computer operation cancelled");
      try { windows.push(await windowState(id, signal)); } catch { }
    }
    return windows;
  }
  return async (name, args, signal) => {
    validate(name, args);
    if (signal.aborted) throw new Error("Computer operation cancelled");
    if (name === "list_apps" || name === "list_windows") {
      const windows = (await list(signal)).filter(window => args.pid === undefined || window.pid === args.pid);
      return textResult(name === "list_apps" ? { apps: windows.map(window => ({ pid: window.pid, name: window.title, windows: [window] })) } : { windows });
    }
    const current = await windowState(args.window_id, signal);
    if (current.pid !== args.pid) throw new Error("Window belongs to a different process");
    if (name === "get_window_state") {
      const token = randomUUID();
      snapshots.delete(current.window_id); snapshots.set(current.window_id, { token, current, expires: Date.now() + 30000 });
      if (snapshots.size > 100) snapshots.delete(snapshots.keys().next().value);
      const result = textResult({ ...current, snapshot_token: token, coordinates: "window-relative", accessibility: "unavailable", delivery_mode: "foreground", elements: [] });
      if (args.include_screenshot !== false) {
        const capture = xwdToPng(await run("xwd", ["-silent", "-id", String(current.window_id)], signal));
        if (capture.width !== current.bounds.width || capture.height !== current.bounds.height) throw new Error("Window resized during capture; read it again");
        result.content.push({ type: "image", mimeType: "image/png", data: capture.png.toString("base64") });
      }
      return result;
    }
    const snapshot = snapshots.get(current.window_id);
    snapshots.delete(current.window_id);
    if (!snapshot || snapshot.token !== args.snapshot_token || snapshot.expires < Date.now() || JSON.stringify(current) !== JSON.stringify(snapshot.current)) throw new Error("Window changed or snapshot expired; call get_window_state again");
    if (args.x !== undefined && (args.x >= current.bounds.width || args.y >= current.bounds.height)) throw new Error("Coordinates are outside the captured window");
    await run("xdotool", ["windowactivate", "--sync", String(current.window_id)], signal);
    const active = Number((await run("xdotool", ["getactivewindow"], signal)).trim());
    if (active !== current.window_id || JSON.stringify(await windowState(current.window_id, signal)) !== JSON.stringify(current)) throw new Error("Window focus or geometry changed; read the window again");
    if (name === "type_text") await run("xdotool", ["type", "--clearmodifiers", "--delay", "0", "--file", "-"], signal, args.text);
    else if (name === "press_key") {
      await run("xdotool", ["key", "--clearmodifiers", args.key], signal);
    } else {
      const command = ["mousemove", "--sync", "--window", String(current.window_id), String(args.x), String(args.y)];
      if (name === "click") command.push("click", "--clearmodifiers", "--repeat", String(args.click_count ?? 1), String({ left: 1, middle: 2, right: 3 }[args.button ?? "left"]));
      if (name === "scroll") command.push("click", "--clearmodifiers", "--repeat", String(args.amount ?? 3), String({ up: 4, down: 5, left: 6, right: 7 }[args.direction]));
      await run("xdotool", command, signal);
    }
    return textResult({ completed: true, window_id: current.window_id, delivery_mode: "foreground", refresh_required: true });
  };
}

module.exports = { createTools, tools, run };
