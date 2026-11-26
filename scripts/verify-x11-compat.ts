import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(path.join(tmpdir(), "omb-x11-compat-"));
const container = `omb-x11-compat-${process.pid}`;
const image = "openmausbot-x11-verify:ubuntu20.04";
let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
try {
  fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TOOL_CALLS: "[]" });
  const doctor = await runControlOmb(["doctor", "--url", fixture.info.url]);
  await mkdir(path.join(scratch, "electron")); await mkdir(path.join(scratch, "server"));
  for (const file of ["cua-linux-runtime.cjs", "cua-linux.cjs", "cua-connection.cjs", "cua-hyprland.cjs", "capabilities.cjs", "x11-compat.cjs", "x11-bundle.cjs"]) {
    await cp(path.join(root, "electron", file), path.join(scratch, "electron", file));
  }
  for (const file of ["local-computer.ts", "proxy-paths.ts"]) await cp(path.join(root, "server", file), path.join(scratch, "server", file));
  await cp(path.join(root, "dist-native", "x11-compat"), path.join(scratch, "helper"), { recursive: true });
  await cp(path.join(root, "scripts", "testing", "x11-compat", "verify.mjs"), path.join(scratch, "verify.mjs"));
  await cp(path.join(root, "server", "testing", "fake-codex-app-server.ts"), path.join(scratch, "fake-codex.ts"));
  await writeFile(path.join(scratch, "package.json"), '{"type":"module"}\n');
  const built = await run("docker", ["build", "--network=host", "--build-arg", "http_proxy", "--build-arg", "https_proxy",
    "--build-arg", `BASE_IMAGE=${process.env.OMB_X11_TEST_BASE_IMAGE ?? "ubuntu:20.04"}`,
    "--build-arg", `FIXTURE_UID=${process.getuid!()}`, "--build-arg", `FIXTURE_GID=${process.getgid!()}`,
    "-t", image, path.join(root, "scripts", "testing", "x11-compat")], { timeout: 900000, maxBuffer: 2 * 1024 * 1024 });
  if (built.stderr) process.stderr.write(`${built.stderr.split("\n").slice(-8).join("\n")}\n`);
  const result = await run("docker", ["run", "--rm", "--init", "--name", container, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--tmpfs", "/tmp:rw,exec,mode=1777,size=512m", "--tmpfs", `/home/fixture:rw,uid=${process.getuid!()},gid=${process.getgid!()},mode=700`, "--mount", `type=bind,src=${scratch},dst=/fixture,readonly`,
    "--mount", `type=bind,src=${process.execPath},dst=/usr/local/bin/node,readonly`,
    ...(process.env.OMB_X11_TEST_PACKAGE_DIR ? ["--mount", `type=bind,src=${path.resolve(process.env.OMB_X11_TEST_PACKAGE_DIR)},dst=/app,readonly`] : []),
    image], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  const evidence = { fixture: fixture.info, doctor, compatibility: JSON.parse(result.stdout) };
  const evidencePath = `${fixture.info.logPath}.x11-compat.json`;
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, evidencePath, compatibility: evidence.compatibility }));
} finally {
  await run("docker", ["rm", "--force", container]).catch(() => {});
  await fixture?.close(); await rm(scratch, { recursive: true, force: true });
}
