import { useState } from "react";

type Props = {
  path: string;
  text: string;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
};

/** 进程日志：等宽、横向/纵向都在框内滚动（390px 下页面本身不横向滚动）。 */
export default function LogSheet({ path, text, loading = false, error = null, onClose }: Props) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  };

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="进程日志">
      <div className="sheet-layer__scrim" onClick={onClose} />
      <div className="sheet sheet--file">
        <header className="sheet__head">
          <span className="sheet__path">{path || "进程日志"}</span>
          <div className="sheet__tools">
            <button
              type="button"
              className="btn btn--chip"
              onClick={() => void copy()}
              disabled={loading || Boolean(error) || text === ""}
            >
              {copied === "ok" ? "已复制" : "复制"}
            </button>
            <button type="button" className="btn btn--icon" onClick={onClose} aria-label="关闭日志">
              ×
            </button>
          </div>
        </header>
        <div className="sheet__body">
          {loading ? <p className="empty">正在读取日志…</p> : null}
          {error ? (
            <p className="msg-error" role="alert">
              {error}
            </p>
          ) : null}
          {copied === "fail" ? (
            <p className="panel__hint">复制失败（浏览器未授权剪贴板）：请长按或拖选日志文本手动复制。</p>
          ) : null}
          {!loading && !error ? <pre className="log-view">{text === "" ? "（日志为空）" : text}</pre> : null}
        </div>
      </div>
    </div>
  );
}
