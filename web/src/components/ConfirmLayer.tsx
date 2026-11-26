import type { ReactNode } from "react";

type Props = {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  danger?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  /** 可选的第二个动作（如「请求停止并终止进程」），只在确实有第二种收尾方式时给。 */
  extraLabel?: string;
  extraBusy?: boolean;
  extraDanger?: boolean;
  onExtra?: () => void;
};

/** 二次确认层：所有写操作（stop / limits / tell / 新建）都先过这一层。 */
export default function ConfirmLayer({
  title,
  children,
  confirmLabel,
  cancelLabel = "取消",
  busy = false,
  danger = false,
  error = null,
  onConfirm,
  onCancel,
  extraLabel,
  extraBusy = false,
  extraDanger = false,
  onExtra,
}: Props) {
  const disabled = busy || extraBusy;

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet-layer__scrim" onClick={onCancel} />
      <div className="sheet sheet--confirm">
        <header className="sheet__head">
          <h2 className="sheet__title">{title}</h2>
          <button type="button" className="btn btn--icon" onClick={onCancel} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="sheet__body">{children}</div>
        {error ? (
          <p className="msg-error sheet__error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="sheet__foot sheet__foot--wrap">
          <button type="button" className="btn" onClick={onCancel} disabled={disabled}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? "btn--danger" : "btn--primary"}`}
            onClick={onConfirm}
            disabled={disabled}
          >
            {busy ? "处理中…" : confirmLabel}
          </button>
          {extraLabel && onExtra ? (
            <button
              type="button"
              className={`btn ${extraDanger ? "btn--danger" : ""}`}
              onClick={onExtra}
              disabled={disabled}
            >
              {extraBusy ? "处理中…" : extraLabel}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
