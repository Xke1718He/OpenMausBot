import { build } from "esbuild";
import { chmod, mkdir, rename, writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { X11_VERSION, X11_EXECUTABLE, verifyX11Bundle } = require("../electron/x11-bundle.cjs");

export async function stageX11Compatibility(destination = path.join(root, "dist-native", "x11-compat")) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("X11 compatibility packaging requires Linux x64");
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(destination), ".x11-stage-"));
  try {
    await chmod(temporary, 0o755);
    const binary = path.join(temporary, X11_EXECUTABLE);
    await build({ entryPoints: [path.join(root, "electron", "x11", "driver.cjs")], outfile: binary, bundle: true, platform: "node", target: "node20", format: "cjs",
      banner: { js: '#!/bin/sh\n\':\' //; exec "${OMB_X11_NODE:-node}" "$0" "$@"' }, logLevel: "silent" });
    await chmod(binary, 0o755);
    const sha256 = createHash("sha256").update(await readFile(binary)).digest("hex");
    await writeFile(path.join(temporary, "release.json"), `${JSON.stringify({ backend: "openmausbot-x11", version: X11_VERSION, sha256 })}\n`, { mode: 0o644 });
    verifyX11Bundle(temporary);
    await mkdir(destination, { recursive: true, mode: 0o755 });
    await chmod(destination, 0o755);
    await rename(binary, path.join(destination, X11_EXECUTABLE));
    await rename(path.join(temporary, "release.json"), path.join(destination, "release.json"));
    return verifyX11Bundle(destination);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Staged X11 compatibility helper ${X11_VERSION}: ${await stageX11Compatibility()}`);
}
