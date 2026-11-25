import type { Client } from "@larksuiteoapi/node-sdk";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { FeishuResourceMetadata } from "./resource-metadata.ts";

const message = { platform: "feishu", account: "app", id: "om_metadata", chatId: "oc_chat", senderId: "ou_person", kind: "direct" as const, text: "" };
const attachment = { kind: "file" as const, key: "file_metadata", name: "data.mcap" };

it.each([
  [{ "content-range": "bytes 0-0/123456789", "content-length": "1" }, 123456789],
  [{ "content-length": "4096" }, 4096],
  [{ "content-range": "bytes */0", "content-length": "0" }, 0],
  [{ "content-length": "0" }, 0],
  [{ "content-range": "bytes 0-0/*", "content-length": "1" }, undefined],
  [{ "content-range": "bytes 1-1/100", "content-length": "1" }, undefined],
  [{ "content-range": "bytes 0-0/100", "content-length": "5" }, undefined],
  [{ "content-length": "5", "content-encoding": "gzip" }, undefined],
  [{ "content-length": "9007199254740992" }, undefined],
  [{}, undefined],
])("reads complete sizes from probe headers and immediately closes the body: %j", async (headers, bytes) => {
  const stream = new Readable({ read() {} });
  const request = vi.fn<Client["request"]>().mockResolvedValue({ data: stream, headers, status: "content-range" in headers ? 206 : 200 });
  const metadata = new FeishuResourceMetadata({ request: request as Client["request"] });
  expect(await metadata.size(message, attachment, new AbortController().signal)).toBe(bytes);
  expect(stream.destroyed).toBe(true);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ responseType: "stream", $return_headers: true,
    headers: { Range: "bytes=0-0", "Accept-Encoding": "identity" } }));
  metadata.close();
});

it("cancels a pending probe and degrades to unknown size instead of starting a second download", async () => {
  const request = vi.fn<Client["request"]>().mockImplementation(options => new Promise((_resolve, reject) => {
    options.signal?.addEventListener?.("abort", () => reject(new Error("aborted")), { once: true });
  }));
  const metadata = new FeishuResourceMetadata({ request: request as Client["request"] }), controller = new AbortController();
  const pending = metadata.size(message, attachment, controller.signal);
  controller.abort();
  expect(await pending).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  metadata.close();
});

it("retains folder sizes without counting a directory's aggregate size again, and probes missing leaf sizes", async () => {
  const stream = Readable.from([]);
  const request = vi.fn<Client["request"]>().mockResolvedValueOnce({ code: 0, data: { all_count: 4, items: [
    { file_key: "file_dir", name: "nested", is_folder: true, size: 100, children: [
      { file_key: "file_payload", name: "data.mcap", is_folder: false, size: "100" },
      { file_key: "file_marker", name: "data.done", is_folder: false },
    ] },
  ] } }).mockResolvedValueOnce({ data: stream, headers: { "content-range": "bytes */0", "content-length": "0" }, status: 206 });
  const metadata = new FeishuResourceMetadata({ request: request as Client["request"] });
  const expanded = await metadata.expand({ ...message, attachments: [{ kind: "folder", key: "file_root", name: "bag" }] }, new AbortController().signal);
  expect(expanded.attachments.map(item => item.bytes)).toEqual([100, 0]);
  expect(expanded.directories).toEqual(["bag", "bag/nested"]);
  expect(request).toHaveBeenCalledTimes(2);
  expect(stream.destroyed).toBe(true);
  metadata.close();
});

it("closes refused probe streams without pretending their error-body length is the file size", async () => {
  const stream = Readable.from(["not authorized"]);
  const request = vi.fn<Client["request"]>().mockRejectedValue({ response: { status: 403, data: stream, headers: { "content-length": "14" } } });
  const metadata = new FeishuResourceMetadata({ request: request as Client["request"] });
  expect(await metadata.size(message, attachment, new AbortController().signal)).toBeUndefined();
  expect(stream.destroyed).toBe(true);
  metadata.close();
});

it("does not treat the length of a partial response without Content-Range as the complete file size", async () => {
  const stream = Readable.from(["x"]);
  const request = vi.fn<Client["request"]>().mockResolvedValue({ data: stream, headers: { "content-length": "1" }, status: 206 });
  const metadata = new FeishuResourceMetadata({ request: request as Client["request"] });
  expect(await metadata.size(message, attachment, new AbortController().signal)).toBeUndefined();
  expect(stream.destroyed).toBe(true); metadata.close();
});
