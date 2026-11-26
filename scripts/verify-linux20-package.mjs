import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { verifyX11Bundle, X11_VERSION } = require("../electron/x11-bundle.cjs");
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.resolve(process.argv[2] ?? path.join(root, "release", "ubuntu20.04"));
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const artifact = path.join(release, `OpenMausBot-${version}-ubuntu20.04-amd64.deb`);
const scratch = await mkdtemp(path.join(tmpdir(), "omb-linux20-package-"));
try {
  const field = async name => (await run("dpkg-deb", ["--field", artifact, name])).stdout.trim();
  assert.equal(await field("Architecture"), "amd64");
  assert.equal(await field("Package"), "openmausbot");
  assert.equal(await field("Version"), version);
  const dependencies = await field("Depends");
  for (const name of ["xdotool", "x11-utils", "x11-apps"]) {
    assert.ok(dependencies.split(",").some(item => item.trim() === name), `Missing package dependency: ${name}`);
  }
  await run("dpkg-deb", ["--extract", artifact, scratch], { timeout: 60000 });
  const app = path.join(scratch, "opt", "OpenMausBot");
  const resources = path.join(app, "resources");
  assert.ok(!(await readdir(resources)).includes("cua-linux-x64"));
  assert.equal((await readFile(path.join(resources, "package-type"), "utf8")).trim(), "deb");
  await access(path.join(resources, "server", "index.js"));
  await access(path.join(resources, "ui", "index.html"));
  const helper = verifyX11Bundle(path.join(resources, "x11-compat"));
  const staged = verifyX11Bundle(path.join(root, "dist-native", "x11-compat"));
  assert.deepEqual(await readFile(helper), await readFile(staged));
  const executable = path.join(app, "openmausbot");
  const output = (await run(helper, ["--version"], { env: { PATH: "/usr/bin:/bin", OMB_X11_NODE: executable, ELECTRON_RUN_AS_NODE: "1" } })).stdout.trim();
  assert.equal(output, `openmausbot-x11 ${X11_VERSION}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  const evidence = { passed: true, artifact, version, architecture: "amd64", dependencies, helperVersion: X11_VERSION,
    embeddedElectronNode: true, sha256: hash.digest("hex") };
  await writeFile(`${artifact}.verification.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally { await rm(scratch, { recursive: true, force: true }); }
