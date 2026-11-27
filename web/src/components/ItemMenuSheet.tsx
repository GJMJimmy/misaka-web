type MenuAction = {
  label: string;
  meta?: string;
  /** 这一条正在请求服务端：按钮显示「处理中…」并禁用。 */
  busy?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

type Props = {
  title: string;
  subtitle?: string;
  actions: MenuAction[];
  error?: string | null;
  onClose: () => void;
};

/** 单条卡片的操作菜单（§3.9 的「从列表隐藏 / 恢复显示」），复用顶部「⋯」菜单的样式。 */
export default function ItemMenuSheet({ title, subtitle, actions, error = null, onClose }: Props) {
  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label={title}>
      <div className="sheet-layer__scrim" onClick={onClose} />
      <div className="sheet sheet--menu">
        <header className="sheet__head">
          <h2 className="sheet__title">{title}</h2>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="sheet__body">
          {subtitle ? <p className="sheet__text sheet__text--muted">{subtitle}</p> : null}
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="menu-row"
              onClick={action.onSelect}
              disabled={action.disabled}
            >
              <span className="menu-row__label">{action.busy ? "处理中…" : action.label}</span>
              {action.meta ? <span className="menu-row__meta">{action.meta}</span> : null}
            </button>
          ))}
          {error ? (
            <p className="msg-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
