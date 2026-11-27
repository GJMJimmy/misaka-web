import { useState } from "react";
import { describeError, hideSession, isUnauthorized, unhideSession } from "../api";
import { formatRelative } from "../format";
import type { Session } from "../types";
import ItemMenuSheet from "./ItemMenuSheet";

type Props = {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  /** CONTRACT §3.9：打开时列表按 include_hidden=1 回读，隐藏项以弱化样式出现。 */
  showHidden: boolean;
  onToggleHidden: () => void;
  onRefresh: () => void;
  /** 隐藏 / 恢复之后由 App 整表回读（不做乐观删除）。 */
  onChanged: () => void;
  onAuthLost: () => void;
  onOpen: (id: string) => void;
  onLogout: () => void;
};

export default function SessionListView({
  sessions,
  loading,
  error,
  showHidden,
  onToggleHidden,
  onRefresh,
  onChanged,
  onAuthLost,
  onOpen,
  onLogout,
}: Props) {
  const [menuSession, setMenuSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<"hide" | "unhide" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const toggleVisibility = async (session: Session) => {
    const hide = session.hidden !== true;
    setBusy(hide ? "hide" : "unhide");
    setActionError(null);
    setFlash(null);
    try {
      if (hide) await hideSession(session.id);
      else await unhideSession(session.id);
      setMenuSession(null);
      onChanged();
      setFlash(hide ? "已从列表隐藏这个会话（MISAKA 里的会话没动，可恢复）。" : "已恢复显示这个会话。");
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      setActionError(`${hide ? "隐藏" : "恢复显示"}失败：${describeError(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="list">
      <div className="list__toolbar">
        <h2 className="list__heading">会话</h2>
        <div className="list__actions">
          <button
            type="button"
            className={`btn btn--chip${showHidden ? " btn--chip-active" : ""}`}
            aria-pressed={showHidden}
            onClick={() => {
              setFlash(null);
              setActionError(null);
              onToggleHidden();
            }}
          >
            显示已隐藏
          </button>
          <button type="button" className="btn btn--chip" onClick={onRefresh} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button type="button" className="btn btn--chip" onClick={onLogout}>
            退出登录
          </button>
        </div>
      </div>

      {error ? (
        <p className="msg-error" role="alert">
          {error}
        </p>
      ) : null}

      {flash ? (
        <p className="panel__hint" role="status">
          {flash}
        </p>
      ) : null}

      {loading && sessions.length === 0 ? <p className="empty">正在读取会话列表…</p> : null}

      {!loading && sessions.length === 0 && !error ? (
        <p className="empty">
          还没有可用的会话。上游 MISAKA 启一个会话后刷新这里；之前隐藏过的项，打开上面的「显示已隐藏」就能找回来。
        </p>
      ) : null}

      <ul className="cards">
        {sessions.map((session) => (
          <li key={session.id} className={`card-row${session.hidden ? " card-row--hidden" : ""}`}>
            <button type="button" className="card" onClick={() => onOpen(session.id)}>
              <span className="card__top">
                <span className="card__title">{session.title?.trim() || session.id}</span>
                <span className={`chip chip--${session.state}`}>
                  {session.state === "live" ? "在线" : "已归档"}
                </span>
              </span>
              <span className="card__meta">
                <span className="chip chip--role">{session.role}</span>
                {session.workspace_missing ? (
                  <span className="chip chip--tone-warn">工作目录已删除</span>
                ) : null}
                {session.hidden ? <span className="chip chip--tone-muted">已隐藏</span> : null}
                {session.has_control ? (
                  <span className="chip chip--control">可控制</span>
                ) : (
                  <span className="chip chip--readonly">只读</span>
                )}
                {session.last_activity ? <span className="card__time">{formatRelative(session.last_activity)}</span> : null}
              </span>
              {session.cwd ? <span className="card__cwd">{session.cwd}</span> : null}
              {session.title?.trim() ? <span className="card__id">{session.id}</span> : null}
            </button>
            <button
              type="button"
              className="btn btn--icon card-row__more"
              aria-label={`「${session.title?.trim() || session.id}」的操作`}
              onClick={() => {
                setActionError(null);
                setMenuSession(session);
              }}
            >
              <span aria-hidden="true">⋯</span>
            </button>
          </li>
        ))}
      </ul>

      {menuSession ? (
        <ItemMenuSheet
          title="会话"
          subtitle={menuSession.title?.trim() || menuSession.id}
          error={actionError}
          actions={[
            menuSession.hidden === true
              ? {
                  label: "恢复显示",
                  meta: "重新出现在会话列表里；MISAKA 里的会话本来就没动过。",
                  busy: busy === "unhide",
                  disabled: busy !== null,
                  onSelect: () => void toggleVisibility(menuSession),
                }
              : {
                  label: "从列表隐藏",
                  meta: "只影响本服务的列表，MISAKA 里的会话不动，可恢复。",
                  busy: busy === "hide",
                  disabled: busy !== null,
                  onSelect: () => void toggleVisibility(menuSession),
                },
          ]}
          onClose={() => {
            if (busy !== null) return;
            setMenuSession(null);
            setActionError(null);
          }}
        />
      ) : null}
    </div>
  );
}
