import { useEffect, useRef, type ReactNode } from "react";
import { formatClock, isRecord, safeJson } from "../format";
import type { Entry, SessionRunState } from "../types";

type Props = {
  entries: Entry[];
  streaming: Entry | null;
  runState: SessionRunState;
};

function renderBlock(block: unknown): ReactNode {
  if (typeof block === "string") return <p className="msg__text">{block}</p>;
  if (isRecord(block)) {
    if (typeof block.text === "string") return <p className="msg__text">{block.text}</p>;
    const type = typeof block.type === "string" ? block.type : "block";
    const name = typeof block.name === "string" ? block.name : "";
    return (
      <details className="tool">
        <summary className="tool__summary">
          <span className="tool__type">{type}</span>
          {name ? <span className="tool__name">{name}</span> : null}
        </summary>
        <pre className="msg__pre">{safeJson(block.input ?? block.content ?? block)}</pre>
      </details>
    );
  }
  return <p className="msg__text">{String(block)}</p>;
}

function renderContent(content: unknown): ReactNode {
  if (content === null || content === undefined) return <p className="msg__text msg__text--muted">（空）</p>;
  if (typeof content === "string") {
    return <p className="msg__text">{content === "" ? "…" : content}</p>;
  }
  if (Array.isArray(content)) {
    return (
      <div className="msg__blocks">
        {content.map((block, index) => (
          <div className="msg__block" key={`block-${index}`}>
            {renderBlock(block)}
          </div>
        ))}
      </div>
    );
  }
  if (isRecord(content) && typeof content.text === "string") {
    return <p className="msg__text">{content.text}</p>;
  }
  return <pre className="msg__pre">{safeJson(content)}</pre>;
}

function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "我";
    case "assistant":
      return "MISAKA";
    case "system":
      return "系统";
    case "tool":
      return "工具";
    default:
      return role || "未知";
  }
}

function roleClass(role: string): string {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") return role;
  return "other";
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

  return (
    <div className="transcript" ref={scrollerRef} onScroll={handleScroll}>
      {isEmpty ? <p className="empty">这个会话还没有任何条目。</p> : null}

      {entries.map((entry, index) => (
        <article className={`msg msg--${roleClass(entry.role)}`} key={`entry-${index}`}>
          <header className="msg__head">
            <span className="msg__role">{roleLabel(entry.role)}</span>
            {entry.ts ? <time className="msg__time">{formatClock(entry.ts)}</time> : null}
          </header>
          <div className="msg__body">{renderContent(entry.content)}</div>
        </article>
      ))}

      {streaming ? (
        <article className={`msg msg--${roleClass(streaming.role)} msg--streaming`} aria-live="polite">
          <header className="msg__head">
            <span className="msg__role">{roleLabel(streaming.role)}</span>
            <span className="msg__live">流式中</span>
          </header>
          <div className="msg__body">
            {renderContent(streaming.content)}
            <span className="caret" aria-hidden="true" />
          </div>
        </article>
      ) : null}

      {runState === "working" && streaming === null ? (
        <p className="working" role="status">
          <span className="working__dot" aria-hidden="true" />
          会话正在处理…
        </p>
      ) : null}
    </div>
  );
}
