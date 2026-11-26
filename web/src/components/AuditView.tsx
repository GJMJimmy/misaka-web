import { useCallback, useEffect, useMemo, useState } from "react";
import { getAudit, setMockResearchMode } from "../api";
import { MOCK } from "../env";
import { classifyError, type LoadFailure } from "../errors";
import { formatRelativeMs, safeJson } from "../format";
import type { AuditEntry } from "../types";

type Props = { onAuthLost: () => void };

const KNOWN_ACTIONS = ["run_start", "resume", "stop", "terminate", "limits", "tell"];

function parseTime(at: string | number | null): number | null {
  if (at === null) return null;
  if (typeof at === "number") return at < 1e12 ? Math.round(at * 1000) : Math.round(at);
  if (/^\d+$/.test(at)) {
    const value = Number.parseInt(at, 10);
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = new Date(at).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

export default function AuditView({ onAuthLost }: Props) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [action, setAction] = useState("");
  const [mockEmpty, setMockEmpty] = useState(false);

  const load = useCallback(
    async (filter: string) => {
      setLoading(true);
      try {
        setEntries(await getAudit(200, filter === "" ? null : filter));
        setFailure(null);
      } catch (err) {
        const classified = classifyError(err, "读取审计日志");
        if (classified.kind === "unauthorized") {
          onAuthLost();
          return;
        }
        setEntries([]);
        setFailure(classified);
      } finally {
        setLoading(false);
      }
    },
    [onAuthLost],
  );

  useEffect(() => {
    void load(action);
  }, [load, action]);

  const actions = useMemo(() => {
    const seen = new Set<string>(KNOWN_ACTIONS);
    for (const entry of entries) seen.add(entry.action);
    return Array.from(seen).sort();
  }, [entries]);

  const toggleMockEmpty = async () => {
    const next = !mockEmpty;
    try {
      await setMockResearchMode({ audit: next ? "empty" : "normal" });
      setMockEmpty(next);
      await load(action);
    } catch {
      setFailure({ kind: "other", message: "（mock）切换审计空态失败。", raw: "" });
    }
  };

  return (
    <div className="list">
      <div className="list__toolbar">
        <h2 className="list__heading">审计日志</h2>
        <div className="list__actions">
          {MOCK ? (
            <button type="button" className="btn btn--chip" onClick={() => void toggleMockEmpty()}>
              {mockEmpty ? "mock: 空态" : "mock: 正常"}
            </button>
          ) : null}
          <button type="button" className="btn btn--chip" onClick={() => void load(action)} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      <div className="chip-row" role="group" aria-label="按 action 过滤">
        <button
          type="button"
          className={`btn btn--chip${action === "" ? " btn--chip-active" : ""}`}
          onClick={() => setAction("")}
        >
          全部
        </button>
        {actions.map((item) => (
          <button
            key={item}
            type="button"
            className={`btn btn--chip${action === item ? " btn--chip-active" : ""}`}
            onClick={() => setAction(item)}
          >
            {item}
          </button>
        ))}
      </div>

      {failure ? (
        <section className="notice notice--error">
          <p className="notice__body" role="alert">
            {failure.message}
          </p>
          <button type="button" className="btn" onClick={() => void load(action)}>
            重试
          </button>
        </section>
      ) : null}

      {loading && entries.length === 0 && !failure ? <p className="empty">正在读取审计日志…</p> : null}

      {!loading && !failure && entries.length === 0 ? (
        <p className="empty">
          还没有写操作。
          {action === "" ? null : `（当前过滤：${action}）`}
          <br />
          stop / limits / tell / run_start / resume 每次成功都会往 token 目录旁的{" "}
          <code>audit.jsonl</code> 追加一行。
        </p>
      ) : null}

      <ul className="plain-list">
        {entries.map((entry, index) => {
          const millis = parseTime(entry.at);
          const absolute = millis === null ? "—" : new Date(millis).toLocaleString("zh-CN");
          const extraKeys = Object.keys(entry.extra);
          return (
            <li className="audit-row" key={`${entry.at ?? "x"}-${entry.action}-${index}`}>
              <div className="audit-row__top">
                <span className="chip chip--role">{entry.action}</span>
                <time className="audit-row__time" title={absolute}>
                  {millis === null ? "—" : formatRelativeMs(millis)}
                </time>
              </div>

              {entry.run_id || entry.node_id || entry.pid !== null ? (
                <div className="audit-row__meta">
                  {entry.run_id ? (
                    <span className="audit-row__field">
                      <span className="audit-row__key">run</span>
                      <code>{entry.run_id}</code>
                    </span>
                  ) : null}
                  {entry.node_id ? (
                    <span className="audit-row__field">
                      <span className="audit-row__key">node</span>
                      <code>{entry.node_id}</code>
                    </span>
                  ) : null}
                  {entry.pid !== null ? (
                    <span className="audit-row__field">
                      <span className="audit-row__key">pid</span>
                      <code>{entry.pid}</code>
                    </span>
                  ) : null}
                </div>
              ) : null}

              {extraKeys.length > 0 ? (
                <details className="tool">
                  <summary className="tool__summary">
                    <span className="tool__type">其它字段</span>
                    <span className="tool__name">{extraKeys.join(", ")}</span>
                  </summary>
                  <pre className="msg__pre">{safeJson(entry.extra)}</pre>
                </details>
              ) : null}

              <p className="audit-row__absolute">{absolute}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
