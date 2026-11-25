import { expect, it } from "vitest";
import { folderFiles } from "./folder.ts";

const file = (name = "record.mcap") => ({ file_key: "file_fixture", name, is_folder: false });
const listing = (items: unknown[]) => {
  const count = (values: unknown[]): number => values.reduce<number>((total, item) => total + 1 + count((item as { children?: unknown[] }).children ?? []), 0);
  return { items, all_count: count(items) + 1 };
};

it("refuses partial trees, repeated paths, unsafe names and excessive expansion", () => {
  for (const value of [
    { items: [file()], all_count: "3" },
    listing([{ file_key: "file_sub", name: "sub", is_folder: true, children_count: "2", children: [file()] }]),
    listing([file(), file()]),
    listing([file("../escape")]),
    listing([file("a\\b")]),
    listing(Array.from({ length: 257 }, (_, i) => file(`${i}.mcap`))),
  ]) expect(() => folderFiles(value, "bag")).toThrowError(expect.objectContaining({ attachmentFailure: "folder" }));
});

it("counts all recursive entries and the root when validating the CLI listing", () => {
  const items = [file("metadata.yaml"), { file_key: "file_sub", name: "nested", is_folder: true, children: [file()] }];
  expect(folderFiles({ items, all_count: 4 }, "bag").attachments.map(item => item.sourcePath)).toEqual(["bag/metadata.yaml", "bag/nested/record.mcap"]);
  expect(() => folderFiles({ items, all_count: 5 }, "bag")).toThrow();
});

it("retains empty directories and an entirely empty folder", () => {
  expect(folderFiles(listing([]), "bag")).toEqual({ attachments: [], directories: ["bag"] });
  expect(folderFiles(listing([{ file_key: "file_empty", name: "empty", is_folder: true, children: [] }]), "bag").directories).toEqual(["bag", "bag/empty"]);
});

it("refuses trees deeper than 32 levels", () => {
  let items: unknown[] = [file()];
  for (let i = 0; i < 33; i++) items = [{ file_key: `file_dir_${i}`, name: "dir", is_folder: true, children_count: "1", children: items }];
  expect(() => folderFiles(listing(items), "bag")).toThrow();
});
