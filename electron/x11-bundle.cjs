const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const X11_VERSION = "1.0.0";
const X11_EXECUTABLE = "openmausbot-x11.cjs";

function verifyX11Bundle(directory) {
  const root = fs.lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o022)) throw new Error("X11 helper directory is unsafe");
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify([X11_EXECUTABLE, "release.json"])) throw new Error("X11 helper bundle has unexpected contents");
  for (const name of [X11_EXECUTABLE, "release.json"]) {
    const stat = fs.lstatSync(path.join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) || (stat.uid !== 0 && stat.uid !== process.getuid())) throw new Error("X11 helper files are unsafe");
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "release.json"), "utf8"));
  const digest = createHash("sha256").update(fs.readFileSync(path.join(directory, X11_EXECUTABLE))).digest("hex");
  if (manifest.backend !== "openmausbot-x11" || manifest.version !== X11_VERSION || manifest.sha256 !== digest ||
      Object.keys(manifest).sort().join(",") !== "backend,sha256,version") throw new Error("X11 helper integrity validation failed");
  return path.join(fs.realpathSync(directory), X11_EXECUTABLE);
}

module.exports = { X11_VERSION, X11_EXECUTABLE, verifyX11Bundle };
