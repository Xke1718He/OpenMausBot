import { fromMarkdown } from "mdast-util-from-markdown";
import { describe, expect, it } from "vitest";
import { FEISHU_REPLY_BYTES, feishuMarkdownParts, feishuReplyBytes } from "./markdown.ts";

const header = "| 排名 | 项目 | 今日新增 ⭐ | 中文简介 |\n| --- | --- | --- | --- |";
const rows = (count: number) => Array.from({ length: count }, (_, i) =>
  `| ${i + 1} | [superpowers-${i + 1}](https://github.com/example/superpowers-${i + 1}) | 1,917 | Agent 编程技能框架与软件开发方法，支持任务执行、工具调用与协作。 |`);

describe("Feishu Markdown delivery", () => {
  it("keeps the screenshot's complete ten-row report in one message instead of cutting a repository name at character 1000", () => {
    const report = `今日 GitHub Trending 全语言榜前 10 名如下：\n\n${header}\n${rows(10).join("\n")}\n\n查看[完整中文报告](https://example.test/report)。`;
    expect(report.length).toBeGreaterThan(1_000);
    expect(feishuMarkdownParts(report)).toEqual([report]);
  });

  it("splits an oversized table only between rows and repeats the header without losing or duplicating a row", () => {
    const data = rows(250);
    const parts = feishuMarkdownParts(`${header}\n${data.join("\n")}`);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.startsWith(header + "\n"))).toBe(true);
    expect(parts.flatMap(part => part.split("\n").slice(2))).toEqual(data);
    expect(parts.every(part => feishuReplyBytes(part) <= FEISHU_REPLY_BYTES)).toBe(true);
  });

  it("keeps links, inline code and emphasis whole when splitting oversized prose", () => {
    const link = "[完整项目说明](https://example.test/repo?key=one&value=two)";
    const prose = (`这是项目介绍，${link}，**重点说明**和\`example --flag\`。 `).repeat(400);
    const parts = feishuMarkdownParts(prose);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.reduce((total, part) => total + part.split(link).length - 1, 0)).toBe(400);
    expect(parts.reduce((total, part) => total + part.split("**重点说明**").length - 1, 0)).toBe(400);
    expect(parts.reduce((total, part) => total + part.split("`example --flag`").length - 1, 0)).toBe(400);
    expect(parts.every(part => feishuReplyBytes(part) <= FEISHU_REPLY_BYTES)).toBe(true);
  });

  it("reopens oversized fenced code with its language and preserves the code, including nested backticks", () => {
    const body = 'const text = "中文 🦊 \\\\ \\\" ```";\n'.repeat(1_500);
    const parts = feishuMarkdownParts(`\`\`\`\`ts\n${body}\`\`\`\``);
    expect(parts.length).toBeGreaterThan(1);
    const nodes = parts.map(part => fromMarkdown(part).children);
    expect(nodes.every(children => children.length === 1 && children[0]?.type === "code" && children[0].lang === "ts")).toBe(true);
    expect(nodes.map(children => children[0]?.type === "code" ? children[0].value : "").join("")).toBe(body.trimEnd());
    expect(parts.every(part => feishuReplyBytes(part) <= FEISHU_REPLY_BYTES)).toBe(true);
  });

  it("measures the serialized UTF-8 request including JSON escaping and never splits an emoji surrogate pair", () => {
    const parts = feishuMarkdownParts('🦊中文"\\'.repeat(12_000));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => feishuReplyBytes(part) <= FEISHU_REPLY_BYTES && !part.includes("\uFFFD") && Buffer.from(part).toString("utf8") === part)).toBe(true);
  });

  it("repairs trailing spaces inside bold delimiters without rewriting inline code, fenced code or escaped asterisks", () => {
    const markdown = '数据于 **11 月 18 日 11:49（北京时间） ** 查询。\n\n`**保留 **` 和 \\*\\*示例 **\n\n```md\n**原样 **\n```';
    expect(feishuMarkdownParts(markdown)).toEqual([markdown.replace("北京时间） **", "北京时间）**")]);
  });

  it("bounds an oversized single list item or table row without recursive splitting", () => {
    for (const text of ["- " + "字".repeat(30_000), `${header}\n| 1 | ${"字".repeat(30_000)} | 0 | 超长单元格 |`]) {
      const parts = feishuMarkdownParts(text);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.every(part => feishuReplyBytes(part) <= FEISHU_REPLY_BYTES)).toBe(true);
    }
  });
});
