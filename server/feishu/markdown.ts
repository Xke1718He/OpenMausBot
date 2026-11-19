import { fromMarkdown } from "mdast-util-from-markdown";

type Block = ReturnType<typeof fromMarkdown>["children"][number];
type Node = { type: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
// https://open.feishu.cn/document/server-docs/im-v1/message/reply: post requests are limited to 30 KB, including escaping.
export const FEISHU_REPLY_BYTES = 24_000;
export const feishuPostContent = (text: string) => JSON.stringify({ zh_cn: { title: "", content: [[{ tag: "md", text }]] } });
export const feishuReplyBytes = (text: string) => Buffer.byteLength(JSON.stringify({
  msg_type: "post", content: feishuPostContent(text), reply_in_thread: false, uuid: "0".repeat(32),
}), "utf8");
const fits = (text: string) => feishuReplyBytes(text) <= FEISHU_REPLY_BYTES;

function normalizeStrong(text: string): string {
  const edits: { start: number; end: number; text: string }[] = [];
  const walk = (node: Node) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (node.type === "text" && start !== undefined && end !== undefined) {
      const raw = text.slice(start, end);
      const fixed = raw.replace(/(?<![\\*])\*\*(?=\S)([^*\n]*?\S)[ \t]+\*\*(?!\*)/g, "**$1**");
      if (fixed !== raw) edits.push({ start, end, text: fixed });
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(fromMarkdown(text));
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

function boundedText(text: string, render: (text: string) => string): string[] {
  const parts: string[] = [];
  const chars = Array.from(text);
  for (let start = 0; start < chars.length;) {
    let low = start + 1, high = chars.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(render(chars.slice(start, middle).join("")))) low = middle;
      else high = middle - 1;
    }
    let end = low;
    if (end < chars.length) {
      const newline = chars.slice(start, end).lastIndexOf("\n");
      if (newline >= 0) end = start + newline + 1;
    }
    parts.push(render(chars.slice(start, end).join("")));
    start = end;
  }
  return parts;
}

function codeParts(text: string, language = ""): string[] {
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(runs.reduce((longest, run) => Math.max(longest, run.length + 1), 3));
  const render = (body: string) => `${fence}${language}\n${body}\n${fence}`;
  if (fits(render(text))) return [render(text)];
  if (!fits(render("🦊"))) return boundedText(text, body => body.split("\n").map(line => `    ${line}`).join("\n"));
  return boundedText(text, render);
}

function pack(blocks: string[], separator = "\n\n"): string[] {
  const parts: string[] = [];
  let pending = "";
  for (const block of blocks) {
    const next = pending ? pending + separator + block : block;
    if (pending && !fits(next)) { parts.push(pending); pending = block; }
    else pending = next;
  }
  if (pending) parts.push(pending);
  return parts;
}

function tableParts(raw: string): string[] | undefined {
  const lines = raw.split("\n");
  const divider = lines.findIndex((line, i) => i > 0 && lines[i - 1]!.includes("|") && line.includes("|") &&
    line.trim().replace(/^\||\|$/g, "").split("|").every(cell => /^\s*:?-+:?\s*$/.test(cell)));
  if (divider < 0) return;
  const header = `${lines[divider - 1]}\n${lines[divider]}`;
  if (!fits(header)) return codeParts(raw);
  const parts: string[] = [];
  if (divider > 1) parts.push(...markdownBlocks(lines.slice(0, divider - 1).join("\n")));
  let pending = header;
  for (let i = divider + 1; i < lines.length; i++) {
    const row = lines[i]!;
    if (!row.includes("|")) {
      parts.push(pending, ...markdownBlocks(lines.slice(i).join("\n")));
      return parts;
    }
    if (!fits(`${header}\n${row}`)) {
      if (pending !== header) parts.push(pending);
      parts.push(...codeParts(`${header}\n${row}`));
      pending = header;
    } else if (!fits(`${pending}\n${row}`)) { parts.push(pending); pending = `${header}\n${row}`; }
    else pending += `\n${row}`;
  }
  if (pending !== header || !parts.length) parts.push(pending);
  return parts;
}

function splitBlock(node: Block, source: string): string[] {
  const start = node.position!.start.offset!, end = node.position!.end.offset!;
  const raw = source.slice(start, end);
  if (fits(raw)) return [raw];
  if (node.type === "code") return codeParts(node.value, node.lang ?? "");
  if (node.type === "paragraph") {
    const table = tableParts(raw);
    if (table) return table;
    const cuts = new Set([0, raw.length]);
    for (const child of node.children) {
      const a = child.position!.start.offset! - start, b = child.position!.end.offset! - start;
      cuts.add(a); cuts.add(b);
      if (child.type === "text") for (const match of raw.slice(a, b).matchAll(/\s+/g)) cuts.add(a + match.index + match[0].length);
    }
    const offsets = [...cuts].sort((a, b) => a - b);
    const spans = offsets.slice(1).map((offset, i) => raw.slice(offsets[i], offset));
    return spans.every(fits) ? pack(spans, "").map(part => part.trim()).filter(Boolean) : codeParts(raw);
  }
  if (node.type === "list") return node.children.flatMap(child => {
    const item = source.slice(child.position!.start.offset!, child.position!.end.offset!);
    return fits(item) ? [item] : codeParts(item);
  });
  return codeParts(raw);
}

function markdownBlocks(text: string): string[] {
  return fromMarkdown(text).children.flatMap(node => splitBlock(node, text));
}

export function feishuMarkdownParts(text: string): string[] {
  const markdown = normalizeStrong(text) || "任务已完成。";
  return fits(markdown) ? [markdown] : pack(markdownBlocks(markdown));
}
