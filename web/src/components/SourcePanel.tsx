import { useEffect, useRef } from "react";
import { formatBytes } from "../format";
import type { SourceList } from "../types";

export type SourceHighlight = { locator?: string; page?: number };

type Props = {
  data: SourceList;
  highlight?: SourceHighlight | null;
  onOpenFile: (path: string, page?: number) => void;
  onClose: () => void;
};

const baseName = (path: string): string => path.split("/").pop() ?? path;

/**
 * 头部只显示相对运行工作区的路径（`nodes/<node_id>/SOURCES.md` / `final/<run>-SOURCES.md`）。
 * 服务端可能给绝对路径（Windows 的 \ 反斜杠也认），所以按 /nodes/ 或 /final/ 锚点切；
 * 切不出锚点就退回 basename —— 绝不把绝对路径铺满头部（原文放到 title 里）。
 */
export function relativeDisplayPath(path: string): string {
  const normalized = (path ?? "").replace(/\\/g, "/");
  const marked = /(?:^|\/)(nodes|final)\/(.+)$/.exec(normalized);
  if (marked) return `${marked[1]}/${marked[2]}`;
  return baseName(normalized);
}

function highlightHint(
  data: SourceList,
  highlight: SourceHighlight | null | undefined,
): string | null {
  if (!highlight) return null;
  if (highlight.locator) {
    const hit = data.sources.find((source) => source.locators.includes(highlight.locator ?? ""));
    if (!hit) return `定位符 ${highlight.locator} 不在任何来源的 locators 里 —— 只高亮这个定位符，不猜文件。`;
    if (!hit.exists) {
      return `定位符 ${highlight.locator} 命中 ${baseName(hit.placed)}，但它不在磁盘上（exists=false）。`;
    }
    return `定位符 ${highlight.locator} 命中 ${baseName(hit.placed)} 第 ${highlight.page ?? "?"} 页 —— 点页码直接打开。`;
  }
  if (typeof highlight.page === "number") {
    const hits = data.sources.filter((source) => source.pages.includes(highlight.page ?? 0));
    if (hits.length === 0) return `清单里没有任何来源带第 ${highlight.page} 页 —— 不猜来源。`;
    return `第 ${highlight.page} 页出现在 ${hits.length} 份来源里（清单里可能有多份，所以不替你猜）。`;
  }
  return null;
}

export default function SourcePanel({ data, highlight, onOpenFile, onClose }: Props) {
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const highlightPage = typeof highlight?.page === "number" ? highlight.page : null;
  const matched = highlight?.locator
    ? data.sources.find((source) => source.locators.includes(highlight.locator ?? "")) ?? null
    : null;
  const hint = highlightHint(data, highlight);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="来源面板">
      <div className="sheet-layer__scrim" onClick={onClose} />
      <div className="sheet sheet--file">
        <header className="sheet__head">
          <span className="sheet__path sheet__path--rel" title={data.path}>
            来源 · {relativeDisplayPath(data.path)}
          </span>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="关闭来源面板">
            ×
          </button>
        </header>

        <div className="sheet__body">
          {hint ? <p className="panel__hint">{hint}</p> : null}
          {data.node_id ? (
            <p className="panel__meta">
              节点 <code>{data.node_id}</code> 的来源清单（{data.sources.length} 份）
            </p>
          ) : (
            <p className="panel__meta">运行级来源清单（{data.sources.length} 份）</p>
          )}

          {data.sources.length === 0 ? <p className="panel__hint">清单是空的。</p> : null}

          <ul className="plain-list">
            {data.sources.map((source, index) => {
              const isMatched = matched?.placed === source.placed;
              const isHighlighted = isMatched || (highlightPage !== null && source.pages.includes(highlightPage));
              return (
                <li key={`${source.placed}-${index}`}>
                  <div
                    className={`source-row${source.exists ? "" : " source-row--missing"}${
                      isHighlighted ? " source-row--highlight" : ""
                    }`}
                    ref={isHighlighted ? highlightRef : undefined}
                  >
                    <div className="source-row__head">
                      <span className="source-row__name">{baseName(source.placed)}</span>
                      {source.exists ? null : <span className="chip chip--tone-warn">磁盘上没有</span>}
                      {isMatched ? <span className="chip chip--tone-ok">定位符命中</span> : null}
                    </div>

                    <div className="source-row__line">
                      <span className="source-row__key">placed</span>
                      <span className="source-row__val">{source.placed}</span>
                    </div>
                    <div className="source-row__line">
                      <span className="source-row__key">original</span>
                      <span className="source-row__val">{source.original}</span>
                    </div>
                    <div className="source-row__line">
                      <span className="source-row__key">sha256</span>
                      <span className="source-row__val">
                        {source.sha256 ? `${source.sha256.slice(0, 8)}…` : "—"}
                        {source.size !== null ? ` · ${formatBytes(source.size)}` : ""}
                      </span>
                    </div>

                    {source.details.length > 0 ? (
                      <ul className="source-row__details">
                        {source.details.map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    ) : null}

                    {source.locators.length > 0 ? (
                      <div className="chip-row">
                        {source.locators.map((locator) => (
                          <span
                            className={`chip ${
                              highlightPage !== null && locator.endsWith(`#p${highlightPage}`)
                                ? "chip--tone-ok"
                                : "chip--tone-muted"
                            }`}
                            key={locator}
                          >
                            {locator}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="chip-row">
                      {source.pages.length === 0 ? (
                        <span className="panel__hint">无页码（文本来源）</span>
                      ) : (
                        source.pages.map((page) => (
                          <button
                            type="button"
                            key={page}
                            className={`btn btn--chip page-chip${highlightPage === page ? " page-chip--active" : ""}`}
                            onClick={() => onOpenFile(source.placed, page)}
                            disabled={!source.exists}
                            title={source.exists ? `打开第 ${page} 页` : "磁盘上没有这个文件"}
                          >
                            第 {page} 页
                          </button>
                        ))
                      )}
                      {source.exists ? (
                        <button type="button" className="btn btn--chip" onClick={() => onOpenFile(source.placed)}>
                          打开文件
                        </button>
                      ) : (
                        <span className="panel__hint">清单里有、磁盘上没有：页码可看，但打不开原文。</span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {data.products.length > 0 ? (
            <>
              <h3 className="panel__title">清单里的产物</h3>
              <ul className="plain-list">
                {data.products.map((product) => (
                  <li key={product.path}>
                    <button type="button" className="file-row" onClick={() => onOpenFile(product.path)}>
                      <span className="file-row__name">{product.title}</span>
                      <span className="file-row__meta">
                        <span className="chip chip--role">{product.kind}</span> {product.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
