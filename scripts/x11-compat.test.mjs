import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { stageX11Compatibility } from "./prepare-x11-linux.mjs";

const require = createRequire(import.meta.url);
const { xwdToPng } = require("../electron/x11/screenshot.cjs");
const { verifyX11Bundle } = require("../electron/x11-bundle.cjs");
const config = require("../electron-builder.linux20.cjs");

function screenshot() {
  const data = Buffer.alloc(108);
  const fields = [100, 7, 2, 24, 2, 1, 0, 0, 32, 0, 32, 32, 8, 4, 0xff0000, 0xff00, 0xff, 8, 256, 0, 2, 1, 0, 0, 0];
  for (const [index, value] of fields.entries()) data.writeUInt32BE(value, index * 4);
  data.writeUInt32LE(0xff0000, 100); data.writeUInt32LE(0x0000ff, 104);
  return data;
}

it("converts X11 true-color pixels to a bounded PNG and rejects malformed captures", () => {
  const { png, width, height } = xwdToPng(screenshot());
  expect([width, height]).toEqual([2, 1]);
  const compressed = [];
  for (let start = 8; start < png.length;) {
    const size = png.readUInt32BE(start), type = png.subarray(start + 4, start + 8).toString();
    if (type === "IDAT") compressed.push(png.subarray(start + 8, start + 8 + size));
    start += size + 12;
  }
  expect([...inflateSync(Buffer.concat(compressed))]).toEqual([0, 255, 0, 0, 255, 0, 0, 255, 255]);
  expect(() => xwdToPng(screenshot().subarray(0, 104))).toThrow();
  const oversized = screenshot(); oversized.writeUInt32BE(100000, 16);
  expect(() => xwdToPng(oversized)).toThrow();
  const indexed = screenshot(); indexed.writeUInt32BE(3, 52);
  expect(() => xwdToPng(indexed)).toThrow();
});

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("stages an executable helper and refuses modified or extra bundle contents", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "omb-x11-bundle-test-"));
  try {
    const binary = await stageX11Compatibility(path.join(directory, "bundle"));
    expect(execFileSync(binary, ["--version"], { env: { OMB_X11_NODE: process.execPath, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }).trim()).toBe("openmausbot-x11 1.0.0");
    expect(JSON.parse(execFileSync(binary, ["manifest"], { env: { OMB_X11_NODE: process.execPath, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" })).backend).toBe("openmausbot-x11");
    expect(verifyX11Bundle(path.dirname(binary))).toBe(binary);
    expect(readFileSync(binary, "utf8")).not.toContain("require(\"./tools.cjs\")");
    appendFileSync(binary, "\n;");
    expect(() => verifyX11Bundle(path.dirname(binary))).toThrow(/integrity/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("packages the compatibility helper and its system tools without the certified CUA runtime", () => {
  expect(config.linux.target).toEqual([{ target: "deb", arch: "x64" }]);
  expect(config.linux.extraResources.some(resource => resource.to === "x11-compat")).toBe(true);
  expect(config.linux.extraResources.some(resource => resource.to === "cua-linux-x64")).toBe(false);
  for (const tool of ["xdotool", "x11-utils", "x11-apps"]) expect(config.deb.fpm).toContain(tool);
  expect(config.publish).toEqual([]);
});
