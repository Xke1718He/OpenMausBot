const path = require("node:path");
const { linuxSession } = require("./capabilities.cjs");
const { desktopCommandEnvironment, runCuaCommand, validateDriverCandidate } = require("./cua-linux.cjs");
const { X11_VERSION, verifyX11Bundle } = require("./x11-bundle.cjs");

async function inspectX11Compatibility({ platform = process.platform, arch = process.arch, env = process.env, bundledDriverPath } = {}) {
  if (platform !== "linux" || arch !== "x64" || linuxSession(platform, env) !== "x11" || !/^:\d+(?:\.\d+)?$/.test(env.DISPLAY ?? "")) {
    return { status: "unavailable", reasonCode: "x11-required", message: "This computer requires a local Xorg session for compatibility mode." };
  }
  try {
    const executable = verifyX11Bundle(path.dirname(bundledDriverPath));
    if (executable !== bundledDriverPath) throw new Error("Unexpected X11 helper path");
    const candidate = validateDriverCandidate(executable);
    if (candidate.status !== "found") return candidate;
    const commandEnv = { ...desktopCommandEnvironment(env), ELECTRON_RUN_AS_NODE: "1", OMB_X11_NODE: process.execPath };
    const version = await runCuaCommand(executable, ["--version"], { env: commandEnv });
    if (version.exitCode !== 0 || version.stdout.trim() !== `openmausbot-x11 ${X11_VERSION}`) throw new Error("Unexpected X11 helper version");
    const manifest = JSON.parse((await runCuaCommand(executable, ["manifest"], { env: commandEnv })).stdout);
    if (manifest.backend !== "openmausbot-x11" || manifest.binary_version !== X11_VERSION || manifest.schema_version !== "1" ||
        manifest.mcp_invocation?.command !== executable || JSON.stringify(manifest.mcp_invocation.args) !== '["mcp"]') throw new Error("Unexpected X11 helper contract");
    const report = await runCuaCommand(executable, ["doctor", "--json"], { env: commandEnv });
    if (report.exitCode !== 0 || JSON.parse(report.stdout).ok !== true) {
      return { status: "unavailable", reasonCode: "x11-tools-missing", message: "Install xdotool, x11-utils and x11-apps, then try enabling local control again." };
    }
    const display = await runCuaCommand("/usr/bin/xdotool", ["getdisplaygeometry"], { env: commandEnv });
    if (display.exitCode !== 0) throw new Error("The Xorg display could not be reached");
    return { status: "ready", session: "x11", path: executable, source: "x11-compat", driverVersion: X11_VERSION, manifestSchema: "1",
      fileIdentity: candidate.fileIdentity, doctor: { warnings: [{ label: "X11 compatibility", status: "warn", message: "Uses the shared pointer and keyboard; window control is based on screenshots and coordinates." }] } };
  } catch (error) {
    return { status: "unavailable", reasonCode: "x11-helper-invalid", message: error.message };
  }
}

module.exports = { inspectX11Compatibility };
