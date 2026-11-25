import { z } from "zod";

export const attachmentContextSchema = z.object({
  directory: z.string().min(1).max(4096).refine(value => !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)).optional(),
}).strict();

export function attachmentContextPrompt(context: z.infer<typeof attachmentContextSchema> | undefined): string {
  if (!context) return "";
  return ["<attachment-context>",
    "附件已保存在后端。按用户要求使用原生图片或文件工具读取，保留相对路径。未连接电脑界面不代表文件不可读；跨环境先确认路径可达，遵守现有权限并如实报告读取错误。",
    ...(context.directory ? [`保存目录：${JSON.stringify(context.directory)}`] : []),
    "</attachment-context>\n\n"].join("\n");
}
