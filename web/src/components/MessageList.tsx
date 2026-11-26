import { memo, useEffect, useRef, type ReactNode } from "react";
import Markdown from "../markdown";
import { formatClock, isRecord, safeJson } from "../format";
import type { Entry, SessionRunState } from "../types";

type Props = {
  entries: Entry[];
  streaming: Entry | null;
  runState: SessionRunState;
};

type Rec = Record<string, unknown>;

/** MISAKA writes session entries, not bare messages: {type, message|summary|data, timestamp}. */
const ENTRY_LABEL: Record<string, string> = {
  compaction: "上下文压缩",
  branch_summary: "分支摘要",
  model_change: "模型切换",
  thinking_level_change: "思考档位切换",
  label: "标签",
  session_info: "会话信息",
  context_edit: "上下文编辑",
  custom: "工作流记录",
  custom_message: "自定义消息",
};

function rec(value: unknown): Rec | null {
  return isRecord(value) ? (value as Rec) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A message-shaped thing: entry.message, or the entry itself when it already looks like one. */
function messageOf(entry: unknown): Rec | null {
  const record = rec(entry);
  if (!record) return null;
  const inner = rec(record.message);
  if (inner) return inner;
  if (typeof record.role === "string") return record;
  return null;
}

function entryType(entry: unknown): string {
  return str(rec(entry)?.type);
}

function blocksOf(message: Rec): unknown[] {
  const content = message.content;
  if (Array.isArray(content)) return content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content === undefined || content === null) {
    const fallback = str(message.text);
    return fallback ? [{ type: "text", text: fallback }] : [];
  }
  return [content];
}

/** Message text is markdown (headings, lists, fences, tables). Memoized: streaming re-renders often. */
const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  if (!text.trim()) return <p className="msg__text msg__text--muted">（空消息）</p>;
  return (
    <div className="msg__md">
      <Markdown text={text} />
    </div>
  );
});

function renderToolCall(block: Rec, key: string): ReactNode {
  const name = str(block.name) || str(block.toolName) || "tool";
  const input = block.input ?? block.arguments ?? block.args ?? {};
  const summary = typeof input === "string" ? input : safeJson(input);
  return (
    <details className="tool" key={key}>
      <summary className="tool__summary">
        <span className="tool__type">→ 调用</span>
        <span className="tool__name">{name}</span>
      </summary>
      <pre className="msg__pre">{summary}</pre>
    </details>
  );
}

function renderThinking(block: Rec, key: string): ReactNode {
  return (
    <details className="tool" key={key}>
      <summary className="tool__summary">
        <span className="tool__type">思考</span>
        <span className="tool__name">{str(block.thinking).slice(0, 40) || "…"}</span>
      </summary>
      <pre className="msg__pre">{str(block.thinking)}</pre>
    </details>
  );
}

function renderBlock(block: unknown, key: string): ReactNode {
  if (typeof block === "string") return <MarkdownText text={block} key={key} />;
  const record = rec(block);
  if (!record) return <p className="msg__text" key={key}>{String(block)}</p>;
  const type = str(record.type);
  if (type === "thinking" || type === "reasoning") return renderThinking(record, key);
  if (type === "toolCall" || type === "tool_call" || type === "toolUse") return renderToolCall(record, key);
  if (type === "image") return <p className="msg__text msg__text--muted" key={key}>[图片]</p>;
  const text = str(record.text);
  if (text) return <MarkdownText text={text} key={key} />;
  // anything else is still data, not a blank line
  return (
    <details className="tool" key={key}>
      <summary className="tool__summary"><span className="tool__type">{type || "内容"}</span></summary>
      <pre className="msg__pre">{safeJson(record)}</pre>
    </details>
  );
}

function renderMessageBody(message: Rec): ReactNode {
  const blocks = blocksOf(message);
  if (blocks.length === 0) {
    return <p className="msg__text msg__text--muted">（空消息）</p>;
  }
  return <div className="msg__blocks">{blocks.map((block, index) => renderBlock(block, `b-${index}`))}</div>;
}

function roleLabel(message: Rec): string {
  const role = str(message.role);
  switch (role) {
    case "user":
      return "我";
    case "assistant":
      return "MISAKA";
    case "system":
      return "系统";
    case "toolResult":
    case "tool":
      return str(message.toolName) ? `工具结果 · ${str(message.toolName)}` : "工具结果";
    case "bashExecution":
      return "命令";
    case "custom":
      return str(message.customType) ? `自定义消息 · ${str(message.customType)}` : "自定义消息";
    default:
      return role || "条目";
  }
}

function roleClass(message: Rec): string {
  const role = str(message.role);
  if (role === "user" || role === "assistant" || role === "system") return role;
  if (role === "toolResult" || role === "tool") return "tool";
  return "other";
}

/** Anything that is not a message: show what it IS instead of an empty bubble. */
function renderEntryRow(entry: unknown, key: string): ReactNode {
  const record = rec(entry) ?? {};
  const type = entryType(entry);
  const label = ENTRY_LABEL[type] ?? (type ? `未知条目 · ${type}` : "未知条目");
  const detail =
    str(record.summary) ||
    str(record.text) ||
    (type === "model_change"
      ? [str(record.provider), str(record.modelId) || str(record.model)].filter(Boolean).join("/")
      : "") ||
    (type === "thinking_level_change" ? str(record.thinkingLevel || record.level) : "") ||
    str(record.customType);
  return (
    <article className="msg msg--system" key={key}>
      <header className="msg__head">
        <span className="msg__role">{label}</span>
        {typeof record.timestamp === "string" ? (
          <time className="msg__time">{formatClock(record.timestamp)}</time>
        ) : null}
      </header>
      {detail ? <div className="msg__body"><p className="msg__text msg__text--muted">{detail}</p></div> : null}
      <details className="tool">
        <summary className="tool__summary"><span className="tool__type">原始条目</span></summary>
        <pre className="msg__pre">{safeJson(entry)}</pre>
      </details>
    </article>
  );
}

function renderEntry(entry: Entry, key: string): ReactNode {
  const message = messageOf(entry);
  if (!message) return renderEntryRow(entry, key);
  return (
    <article className={`msg msg--${roleClass(message)}`} key={key}>
      <header className="msg__head">
        <span className="msg__role">{roleLabel(message)}</span>
        {typeof message.timestamp === "string" ? <time className="msg__time">{formatClock(message.timestamp)}</time> : null}
      </header>
      <div className="msg__body">{renderMessageBody(message)}</div>
    </article>
  );
}

export default function MessageList({ entries, streaming, runState }: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distance < 96;
  };

  // 流式追加时只在用户仍贴着底部时跟随，避免抢走手动上翻的阅读位置。
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, streaming]);

  const isEmpty = entries.length === 0 && streaming === null;
  const streamingMessage = messageOf(streaming);

  return (
    <div className="transcript" ref={scrollerRef} onScroll={handleScroll}>
      {isEmpty ? <p className="empty">这个会话还没有任何条目。</p> : null}

      {entries.map((entry, index) => renderEntry(entry, `entry-${index}`))}

      {streamingMessage ? (
        <article className={`msg msg--${roleClass(streamingMessage)} msg--streaming`} aria-live="polite">
          <header className="msg__head">
            <span className="msg__role">{roleLabel(streamingMessage)}</span>
            <span className="msg__live">流式中</span>
          </header>
          <div className="msg__body">
            {renderMessageBody(streamingMessage)}
            <span className="caret" aria-hidden="true" />
          </div>
        </article>
      ) : null}

      {runState === "working" && streamingMessage === null ? (
        <p className="working" role="status">
          <span className="working__dot" aria-hidden="true" />
          会话正在处理…
        </p>
      ) : null}
    </div>
  );
}