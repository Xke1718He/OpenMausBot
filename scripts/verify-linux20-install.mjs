import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = path.resolve(process.argv[2] ?? "");
if (!artifact.endsWith(".deb")) throw new Error("Pass the compatibility .deb path and optionally the previous failing .deb path");
await access(artifact);
const broken = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (broken) await access(broken);
const image = "openmausbot-linux20-install-verify:latest";
const container = `omb-linux20-install-${process.pid}`;
try {
  const build = await run("docker", ["build", "--network=host", "--build-arg", "http_proxy", "--build-arg", "https_proxy",
    "-f", path.join(root, "scripts/testing/x11-compat/Dockerfile.install"), "-t", image, path.join(root, "scripts/testing/x11-compat")],
  { timeout: 900000, maxBuffer: 2 * 1024 * 1024 });
  if (build.stderr) process.stderr.write(`${build.stderr.split("\n").slice(-8).join("\n")}\n`);
  const result = await run("docker", ["run", "--rm", "--init", "--name", container, "--network", "none",
    "--mount", `type=bind,src=${artifact},dst=/fixture/fixed.deb,readonly`,
    "--mount", `type=bind,src=${path.join(root, "scripts/testing/x11-compat/install.mjs")},dst=/fixture/install.mjs,readonly`,
    "--mount", `type=bind,src=${process.execPath},dst=/usr/local/bin/node,readonly`,
    ...(broken ? ["--mount", `type=bind,src=${broken},dst=/fixture/broken.deb,readonly`] : []), image],
  { timeout: 300000, maxBuffer: 2 * 1024 * 1024 });
  const evidence = { artifact, ...JSON.parse(result.stdout) };
  await writeFile(`${artifact}.install-verification.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally { await run("docker", ["rm", "--force", container]).catch(() => {}); }
