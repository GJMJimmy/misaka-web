import { useEffect, useMemo, useState } from "react";
import { ApiError, describeError, fetchRunFileText, runFileUrl } from "../api";
import type { CitationSpan } from "../markdown-parse";
import Markdown from "../markdown";

type Props = {
  runId: string;
  path: string;
  nodeId?: string | null;
  page?: number;
  onClose: () => void;
  onOpenSources?: () => void;
  onCitation?: (span: CitationSpan) => void;
};

type TextState =
  | { kind: "loading" }
  | { kind: "ready"; text: string }
  | { kind: "error"; message: string; notFound: boolean };

const baseName = (path: string): string => path.split("/").pop() ?? path;

/**
 * 文件 sheet（CONTRACT §3.5）：
 * - PDF → 浏览器内建查看器 <embed>，页码放在 hash；外加「在新标签打开」（iOS Safari 必需）。
 * - markdown → 自写渲染器（引用可点）；*-SOURCES.md → 等宽纯文本 + 来源面板入口。
 * - 其它文本 → 等宽纯文本。
 */
/** iOS/iPadOS Safari renders an iframe PDF as a dead first page, so the sheet offers the tab instead. */
function isIosLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

export default function FileSheet({ runId, path, nodeId, page, onClose, onOpenSources, onCitation }: Props) {
  const lower = path.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const name = baseName(path);
  const lowerName = name.toLowerCase();
  const isSourcesManifest = lowerName.endsWith("-sources.md") || lowerName === "sources.md";
  const isMarkdown = !isSourcesManifest && (lower.endsWith(".md") || lower.endsWith(".markdown"));

  const [current, setCurrent] = useState<number>(page ?? 1);
  const [pageText, setPageText] = useState<string>(String(page ?? 1));
  const [textState, setTextState] = useState<TextState>({ kind: "loading" });
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  useEffect(() => {
    setCurrent(page ?? 1);
    setPageText(String(page ?? 1));
  }, [page, path]);

  useEffect(() => {
    if (isPdf) return;
    let cancelled = false;
    setTextState({ kind: "loading" });
    void (async () => {
      try {
        const text = await fetchRunFileText(runId, path, nodeId);
        if (!cancelled) setTextState({ kind: "ready", text });
      } catch (err) {
        if (cancelled) return;
        const notFound = err instanceof ApiError && err.status === 404;
        setTextState({
          kind: "error",
          message: notFound ? "这个路径不在产物里（404）。" : describeError(err),
          notFound,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runId, path, nodeId, isPdf]);

  const fileUrl = useMemo(
    () => runFileUrl(runId, path, nodeId),
    [runId, path, nodeId],
  );
  const embedUrl = current > 1 ? `${fileUrl}#page=${current}` : fileUrl;

  const goToPage = (next: number) => {
    const clamped = Math.max(1, Math.min(Math.floor(Number.isFinite(next) ? next : 1), 9999));
    setCurrent(clamped);
    setPageText(String(clamped));
  };

  const copyLink = async () => {
    const absolute = new URL(embedUrl, window.location.href).href;
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  };

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label={`文件 ${name}`}>
      <div className="sheet-layer__scrim" onClick={onClose} />
      <div className="sheet sheet--file">
        <header className="sheet__head">
          <span className="sheet__path">{path}</span>
          <div className="sheet__tools">
            {onOpenSources ? (
              <button type="button" className="btn btn--chip" onClick={onOpenSources}>
                来源面板
              </button>
            ) : null}
            <button type="button" className="btn btn--icon" onClick={onClose} aria-label="关闭文件">
              ×
            </button>
          </div>
        </header>

        {isPdf ? (
          <>
            <div className="pdf-toolbar">
              <button
                type="button"
                className="btn btn--chip"
                onClick={() => goToPage(current - 1)}
                disabled={current <= 1}
              >
                上一页
              </button>
              <label className="pdf-toolbar__page">
                <span className="panel__hint">页码</span>
                <input
                  className="field__input pdf-toolbar__input"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={pageText}
                  onChange={(event) => setPageText(event.target.value)}
                  onBlur={() => goToPage(Number.parseInt(pageText, 10))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") goToPage(Number.parseInt(pageText, 10));
                  }}
                  aria-label="页码"
                />
              </label>
              <button type="button" className="btn btn--chip" onClick={() => goToPage(current + 1)}>
                下一页
              </button>
              <button type="button" className="btn btn--chip" onClick={() => void copyLink()}>
                {copied === "ok" ? "已复制" : copied === "fail" ? "复制失败" : "复制链接"}
              </button>
              <a className="btn btn--chip" href={embedUrl} target="_blank" rel="noreferrer noopener">
                在新标签打开
              </a>
            </div>

            <div className="sheet__body">
              {isIosLike() ? (
                <div className="pdf-ios">
                  <p className="pdf-ios__name">{name}</p>
                  <p className="panel__hint">
                    iOS / iPadOS 的 Safari 无法在应用内翻页显示 PDF，这里改成在同一页的新标签里打开。
                  </p>
                  <a className="btn btn--primary btn--block" href={embedUrl} target="_blank" rel="noreferrer noopener">
                    在新标签打开第 {current} 页
                  </a>
                </div>
              ) : (
                <>
                  <embed
                    key={embedUrl}
                    className="pdf-embed"
                    type="application/pdf"
                    src={embedUrl}
                    title={name}
                  />
                  <p className="panel__hint">
                    这里空白说明这个浏览器没有内建 PDF 查看器：用上面的「在新标签打开」。
                  </p>
                  <p className="panel__meta panel__meta--wrap">{embedUrl}</p>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="sheet__body sheet__body--doc">
            {textState.kind === "loading" ? <p className="empty">正在读取…</p> : null}
            {textState.kind === "error" ? (
              <p className={textState.notFound ? "notice notice--warn" : "msg-error"} role="alert">
                {textState.message}
              </p>
            ) : null}
            {textState.kind === "ready" ? (
              isMarkdown ? (
                <Markdown text={textState.text} onCitation={onCitation} />
              ) : (
                <pre className="log-view">{textState.text}</pre>
              )
            ) : null}
            {textState.kind === "ready" && isSourcesManifest && onOpenSources ? (
              <button type="button" className="btn" onClick={onOpenSources}>
                打开来源面板
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}