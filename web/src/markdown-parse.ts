/**
 * 块级 Markdown 解析（纯函数，无 JSX、无依赖）—— 便于在 Node 里直接跑自检。
 * 渲染在 markdown.tsx；行内语法也在那边（要产出 React 元素）。
 */

export type ListItem = { text: string; indent: number };

/** 行内语法拆成 token 序列（纯数据，渲染在 markdown.tsx）。 */
export type InlineToken =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "strike"; text: string }
  | { type: "link"; text: string; url: string };

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\[[^\]\n]*\]\([^)\n]*\))|(\*[^*\n]+\*)|(_[^_\n]+_)/g;

export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;

  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > cursor) tokens.push({ type: "text", text: text.slice(cursor, match.index) });
    const token = match[0];
    if (token.startsWith("`")) {
      tokens.push({ type: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      tokens.push({ type: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("~~")) {
      tokens.push({ type: "strike", text: token.slice(2, -2) });
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]*)\]\(([^)]*)\)$/.exec(token);
      tokens.push({ type: "link", text: link?.[1] ?? token, url: link?.[2] ?? "" });
    } else {
      tokens.push({ type: "italic", text: token.slice(1, -1) });
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) tokens.push({ type: "text", text: text.slice(cursor) });
  return tokens;
}

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; body: string }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "quote"; text: string }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "hr" };

const FENCE_RE = /^\s{0,3}(?:```|~~~)(.*)$/;
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export function parseMarkdown(source: string): Block[] {
  const lines = (source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_RE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过收尾 fence；缺失也不报错
      blocks.push({ type: "code", lang, body: body.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      index += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const parts: string[] = [];
      while (index < lines.length) {
        const quoted = QUOTE_RE.exec(lines[index]);
        if (!quoted) break;
        parts.push(quoted[1]);
        index += 1;
      }
      blocks.push({ type: "quote", text: parts.join("\n") });
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && TABLE_SEP_RE.test(lines[index + 1])) {
      const head = splitRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }

    const orderedItem = OL_RE.exec(line);
    const unorderedItem = UL_RE.exec(line);
    if (orderedItem || unorderedItem) {
      const ordered = Boolean(orderedItem);
      const items: ListItem[] = [];
      while (index < lines.length) {
        const ol = ordered ? OL_RE.exec(lines[index]) : null;
        const ul = ordered ? null : UL_RE.exec(lines[index]);
        const hit = ordered ? ol : ul;
        if (!hit) break;
        const indent = (ordered ? (ol?.[1] ?? "") : (ul?.[1] ?? "")).replace(/\t/g, "  ").length;
        const text = ordered ? (ol?.[3] ?? "") : (ul?.[2] ?? "");
        items.push({ text, indent: Math.min(Math.floor(indent / 2), 3) });
        index += 1;
        // 缩进续行并入上一条
        while (
          index < lines.length &&
          /^\s{2,}\S/.test(lines[index]) &&
          !UL_RE.test(lines[index]) &&
          !OL_RE.test(lines[index])
        ) {
          const last = items[items.length - 1];
          items[items.length - 1] = { ...last, text: `${last.text} ${lines[index].trim()}` };
          index += 1;
        }
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (
        current.trim() === "" ||
        FENCE_RE.test(current) ||
        HEADING_RE.test(current) ||
        QUOTE_RE.test(current) ||
        HR_RE.test(current) ||
        UL_RE.test(current) ||
        OL_RE.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}
