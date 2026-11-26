type Props = {
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenAudit: () => void;
  onLogout: () => void;
  notificationSupported: boolean;
  permission: NotificationPermission | "unsupported";
  onEnableReminders: () => void;
  attention: number;
  mock: boolean;
};

/** 顶部「⋯」菜单：设置（配置台）/ 审计日志 / 提醒 / 退出登录。手机上一两个点击可达。 */
export default function MenuSheet({
  onClose,
  onOpenSettings,
  onOpenAudit,
  onLogout,
  notificationSupported,
  permission,
  onEnableReminders,
  attention,
  mock,
}: Props) {
  const reminderState =
    permission === "granted"
      ? "已开启"
      : permission === "denied"
        ? "已被浏览器拒绝（去站点设置里改）"
        : permission === "unsupported"
          ? "此浏览器不支持通知"
          : "未开启";

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="菜单">
      <div className="sheet-layer__scrim" onClick={onClose} />
      <div className="sheet sheet--menu">
        <header className="sheet__head">
          <h2 className="sheet__title">菜单</h2>
          <button type="button" className="btn btn--icon" onClick={onClose} aria-label="关闭菜单">
            ×
          </button>
        </header>

        <div className="sheet__body">
          <button type="button" className="menu-row" onClick={onOpenSettings}>
            <span className="menu-row__label">设置（配置台）</span>
            <span className="menu-row__meta">模型与密钥 / Sisters / 项目</span>
          </button>

          <button type="button" className="menu-row" onClick={onOpenAudit}>
            <span className="menu-row__label">审计日志</span>
            <span className="menu-row__meta">stop / limits / tell / run_start 的写入记录</span>
          </button>

          <div className="menu-row menu-row--static">
            <span className="menu-row__label">
              待办提醒
              {attention > 0 ? <span className="badge badge--attention">{attention}</span> : null}
            </span>
            <span className="menu-row__meta">
              标签标题前缀 + 页面打开时的本地通知（不是服务端推送）：{reminderState}
            </span>
            {notificationSupported && permission === "default" ? (
              <button type="button" className="btn btn--chip menu-row__action" onClick={onEnableReminders}>
                开启提醒
              </button>
            ) : null}
          </div>

          <button type="button" className="menu-row" onClick={onLogout}>
            <span className="menu-row__label">退出登录</span>
            <span className="menu-row__meta">清掉本地 token 与 cookie 会话</span>
          </button>

          {mock ? (
            <p className="panel__hint">
              VITE_MOCK=1：后端是本地 mock，研究列表 / 进程 / 审计都有各自的演示开关。
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
