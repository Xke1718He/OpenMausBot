import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";

assert.equal(process.getuid(), 0);
assert.ok(existsSync("/.dockerenv"));
assert.match(readFileSync("/etc/os-release", "utf8"), /VERSION_ID="20.04"/);
assert.equal(spawnSync("dpkg-query", ["-W", "openmausbot"]).status, 1);
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 120000 });
const status = () => run("dpkg-query", ["-W", "-f=${Status}", "openmausbot"]).trim();
let reproduced = false;
if (existsSync("/fixture/broken.deb")) {
  const broken = spawnSync("dpkg", ["--install", "/fixture/broken.deb"], { encoding: "utf8", timeout: 120000 });
  assert.equal(broken.status, 1, `${broken.stdout}\n${broken.stderr}`);
  assert.match(broken.stderr, /package directory is missing or unsafe: \/opt\/OpenMausBot\/resources\/cua-linux-x64/);
  assert.equal(status(), "install ok half-configured");
  reproduced = true;
}
run("dpkg", ["--install", "/fixture/fixed.deb"]);
assert.equal(status(), "install ok installed");
for (const [file, mode] of [
  ["/opt/OpenMausBot", 0o755],
  ["/opt/OpenMausBot/resources", 0o755],
  ["/opt/OpenMausBot/resources/x11-compat", 0o755],
  ["/opt/OpenMausBot/resources/x11-compat/openmausbot-x11.cjs", 0o755],
  ["/opt/OpenMausBot/resources/x11-compat/release.json", 0o644],
  ["/opt/OpenMausBot/chrome-sandbox", 0o4755],
]) {
  const stat = lstatSync(file);
  assert.equal(stat.isSymbolicLink(), false, file);
  assert.equal(stat.uid, 0, file);
  assert.equal(stat.gid, 0, file);
  assert.equal(stat.mode & 0o7777, mode, file);
}
assert.equal(existsSync("/opt/OpenMausBot/resources/cua-linux-x64"), false);
run("/bin/sh", ["/var/lib/dpkg/info/openmausbot.postinst", "configure"]);
run("dpkg", ["--install", "/fixture/fixed.deb"]);
assert.equal(run("dpkg", ["--audit"]).trim(), "");
run("dpkg", ["--remove", "openmausbot"]);
assert.equal(status(), "deinstall ok config-files");
run("apt-get", ["install", "-y", "/fixture/fixed.deb"]);
assert.equal(status(), "install ok installed");
run("apt-get", ["--fix-broken", "install", "-y"]);
assert.equal(run("dpkg", ["--audit"]).trim(), "");
run("dpkg", ["--remove", "openmausbot"]);
assert.equal(status(), "deinstall ok config-files");
console.log(JSON.stringify({ passed: true, os: "Ubuntu 20.04", reproduced,
  checks: ["dpkg installation", ...(reproduced ? ["repair half-configured package"] : []), "installed owner and modes", "Chromium sandbox", "idempotent postinst", "dpkg reinstallation", "APT installation", "APT dependency check", "dpkg audit", "removal"] }));
