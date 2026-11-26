import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, describeError, getRunSources, isUnauthorized } from "../api";
import type { CitationSpan } from "../markdown-parse";
import type { SourceList } from "../types";
import FileSheet from "./FileSheet";
import SourcePanel, { type SourceHighlight } from "./SourcePanel";

export type SourceRequest = {
  path?: string;
  page?: number;
  highlight?: SourceHighlight | null;
  /** 一个待解析的引用（定位符/页码/路径）：加载清单后按 §3.5 的规则跳转。 */
  citation?: CitationSpan;
};

type Props = {
  runId: string;
  nodeId?: string | null;
  initial?: SourceRequest | null;
  onClose: () => void;
  onAuthLost: () => void;
};

type View = { kind: "sources"; highlight?: SourceHighlight | null } | { kind: "file"; path: string; page?: number };

/**
 * 来源面板 + 文件 sheet 的宿主，负责 §3.5 的跳转规则：
 * - doc:<id>#p<n> 命中某来源的 locators → 直接开该文件第 n 页；
 * - 命中不了（或该来源 exists=false）→ 只打开来源面板并高亮，不猜文件；
 * - p.<n> / p<n> → 只打开来源面板并高亮该页；
 * - downloads/… nodes/… final/… sources/… → 直接开文件（404 给可读提示）。
 */
export default function SourceBrowser({ runId, nodeId, initial, onClose, onAuthLost }: Props) {
  const [sources, setSources] = useState<SourceList | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [view, setView] = useState<View>(() =>
    initial?.path
      ? { kind: "file", path: initial.path, page: initial.page }
      : { kind: "sources", highlight: initial?.highlight ?? null },
  );

  const loadSources = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getRunSources(runId, nodeId);
      setSources(data);
      setNote(null);
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setNote(err.message || "还没有来源清单。");
      } else {
        setNote(`读取来源清单失败：${describeError(err)}`);
      }
    } finally {
      setLoading(false);
    }
  }, [runId, nodeId, onAuthLost]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  const handleCitation = useCallback(
    (span: CitationSpan) => {
      if (span.kind === "path") {
        setView({ kind: "file", path: span.path });
        return;
      }
      if (span.kind === "locator") {
        const hit = sources?.sources.find((source) => source.locators.includes(span.locator)) ?? null;
        if (hit && hit.exists) {
          setView({ kind: "file", path: hit.placed, page: span.page });
          return;
        }
        setView({ kind: "sources", highlight: { locator: span.locator, page: span.page } });
        return;
      }
      setView({ kind: "sources", highlight: { page: span.page } });
    },
    [sources],
  );
  // 从会话点进来的引用：清单到手后立刻按同一套规则解析，直接开到那一页。
  const autoRef = useRef<CitationSpan | null>(initial?.citation ?? null);
  useEffect(() => {
    if (!sources || !autoRef.current) return;
    const pending = autoRef.current;
    autoRef.current = null;
    void handleCitation(pending);
  }, [sources, handleCitation]);


  if (view.kind === "file") {
    return (
      <FileSheet
        runId={runId}
        path={view.path}
        nodeId={nodeId}
        page={view.page}
        onClose={onClose}
        onOpenSources={() => setView({ kind: "sources", highlight: null })}
        onCitation={handleCitation}
      />
    );
  }

  if (note) {
    return (
      <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="来源面板">
        <div className="sheet-layer__scrim" onClick={onClose} />
        <div className="sheet sheet--confirm">
          <header className="sheet__head">
            <h2 className="sheet__title">没有来源清单</h2>
            <button type="button" className="btn btn--icon" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </header>
          <div className="sheet__body">
            <p className="panel__hint">{note}</p>
            <p className="panel__hint">
              清单在节点产出后写在 <code>sources/SOURCES.md</code>，运行级则在{" "}
              <code>final/*-SOURCES.md</code>。
            </p>
          </div>
          <footer className="sheet__foot">
            <button type="button" className="btn" onClick={onClose}>
              关闭
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void loadSources()}>
              重试
            </button>
          </footer>
        </div>
      </div>
    );
  }

  if (loading || !sources) {
    return (
      <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="来源面板">
        <div className="sheet-layer__scrim" onClick={onClose} />
        <div className="sheet sheet--confirm">
          <header className="sheet__head">
            <h2 className="sheet__title">来源</h2>
            <button type="button" className="btn btn--icon" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </header>
          <div className="sheet__body">
            <p className="empty">正在读取来源清单…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <SourcePanel
      data={sources}
      highlight={view.kind === "sources" ? view.highlight : null}
      onOpenFile={(path, page) => setView({ kind: "file", path, page })}
      onClose={onClose}
    />
  );
}