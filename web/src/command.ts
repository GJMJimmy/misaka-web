import type { CommandBubble, CommandResult } from "./types";

/**
 * 斜杠命令的纯函数部分（CONTRACT §3.8）：
 * 判定、补全拆解、以及把服务端结果变成一条本地气泡。
 * 这里不发请求、不碰会话状态——桥接层解析的结果永远不写会话、不发模型。
 */

/** 单个 / 开头才是命令；`//` 是上游约定：原样发给模型。 */
export function isSlashCommand(text: string): boolean {
  return text.startsWith("/") && !text.startsWith("//");
}

/** 输入只有 / 或 /+前缀（还没有空白）时才该弹补全。 */
export function completionQuery(text: string): string | null {
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  if (/\s/.test(text)) return null;
  return text;
}

/** 建议串形如 "/research tell [TEXT]"：前缀匹配整串，大小写不敏感。 */
export function matchesQuery(suggestion: string, prefix: string): boolean {
  return suggestion.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * 点选补全 → 「命令 + 空格」，方括号占位提示单独返回（例如 /research tell + "TEXT"）。
 */
export function splitSuggestion(suggestion: string): { insertion: string; argHint: string } {
  const match = /\[([^\]]*)\]/.exec(suggestion);
  if (!match) return { insertion: `${suggestion.trimEnd()} `, argHint: "" };
  const head = suggestion.slice(0, match.index).trimEnd();
  return { insertion: `${head} `, argHint: match[1] };
}

/** 服务端的 navigate 是 "#/run/r_x" 形状；容忍没写 # 或 / 的变体。 */
function hashOf(navigate: string | null | undefined): string | null {
  if (typeof navigate !== "string") return null;
  const value = navigate.trim();
  if (value === "") return null;
  if (value.startsWith("#")) return value;
  return value.startsWith("/") ? `#${value}` : `#/${value}`;
}

function commandName(text: string): string {
  const body = text.trim().replace(/^\/+/, "");
  return body.split(/\s+/)[0] ?? body;
}

function cleanLines(lines: unknown, ok: boolean): string[] {
  const out = Array.isArray(lines) ? lines.filter((line): line is string => typeof line === "string") : [];
  if (out.length > 0) return out;
  return [ok ? "（这条命令没有输出）" : "服务端没有给出原因。"];
}

let seq = 0;
const nextId = (): string => `cmd-${++seq}`;

/** ok:true / ok:false 都走这里：失败只是气泡样式不同，绝不回落到发送。 */
export function bubbleOf(requested: string, result: CommandResult): CommandBubble {
  const title = typeof result.title === "string" && result.title.trim() !== "" ? result.title : "命令结果";
  return {
    id: nextId(),
    tone: result.ok ? "ok" : "error",
    command: typeof result.command === "string" && result.command !== "" ? result.command : commandName(requested),
    title,
    lines: cleanLines(result.lines, result.ok),
    navigate: hashOf(result.navigate),
    unsupported: result.unsupported === true,
  };
}

/** 422 等错误：服务端 message 原样写成一行，不解释、不改写、不回落到发送。 */
export function errorBubble(requested: string, message: string): CommandBubble {
  return {
    id: nextId(),
    tone: "error",
    command: commandName(requested),
    title: "命令没有执行",
    lines: [message],
    navigate: null,
    unsupported: false,
  };
}
