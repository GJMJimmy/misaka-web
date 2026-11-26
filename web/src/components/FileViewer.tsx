import Markdown from "../markdown";

type Props = {
  name: string;
  text: string;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
};

/** 文件全文（节点目录内的 .md/.txt）用自写 Markdown 渲染，代码块内部滚动。 */
export default function FileViewer({ name, text, loading = false, error = null, onClose }: Props) {
  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label={`文件 ${name}`}>
      <div className="sheet-layer__scrim" onClick={onClose} />
      <div className="sheet sheet--file">
        <header className="sheet__head">
          <span className="sheet__path">{name}</span>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="关闭文件">
            ×
          </button>
        </header>
        <div className="sheet__body sheet__body--doc">
          {loading ? <p className="empty">正在读取…</p> : null}
          {error ? (
            <p className="msg-error" role="alert">
              {error}
            </p>
          ) : null}
          {!loading && !error ? <Markdown text={text} /> : null}
        </div>
      </div>
    </div>
  );
}
