import { formatRelative } from "../format";
import type { Session } from "../types";

type Props = {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpen: (id: string) => void;
  onLogout: () => void;
};

export default function SessionListView({ sessions, loading, error, onRefresh, onOpen, onLogout }: Props) {
  return (
    <div className="list">
      <div className="list__toolbar">
        <h2 className="list__heading">会话</h2>
        <div className="list__actions">
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

      {loading && sessions.length === 0 ? <p className="empty">正在读取会话列表…</p> : null}

      {!loading && sessions.length === 0 && !error ? (
        <p className="empty">还没有可用的会话。上游 MISAKA 启一个会话后刷新这里。</p>
      ) : null}

      <ul className="cards">
        {sessions.map((session) => (
          <li key={session.id}>
            <button type="button" className="card" onClick={() => onOpen(session.id)}>
              <span className="card__top">
                <span className="card__title">{session.title?.trim() || session.id}</span>
                <span className={`chip chip--${session.state}`}>
                  {session.state === "live" ? "在线" : "已归档"}
                </span>
              </span>
              <span className="card__meta">
                <span className="chip chip--role">{session.role}</span>
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
          </li>
        ))}
      </ul>
    </div>
  );
}
