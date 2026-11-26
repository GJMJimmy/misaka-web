import { useCallback, useEffect, useMemo, useState } from "react";
import { changeRunLimits, getRun, stopRun } from "../api";
import { classifyError, type LoadFailure } from "../errors";
import { formatRelativeMs } from "../format";
import {
  EDITABLE_LIMITS,
  type EditableLimitKey,
  type LimitChanges,
  type NodeSummary,
  type RunDetail,
} from "../types";
import ConfirmLayer from "./ConfirmLayer";
import StatusChip from "./StatusChip";

type Props = { runId: string; onOpenNode: (nodeId: string) => void; onAuthLost: () => void };
type Notice = { kind: "ok" | "error"; text: string };

const LIMIT_HINT: Record<EditableLimitKey, string> = {
  sister_parallel: "兄弟节点并行度（1..8）",
  parallel: "单个节点内并行度（1..8）",
  max_followups: "最多追问轮数（0..20）",
  max_revisions: "最多修订次数（0..10）",
};

export default function RunDetailView({ runId, onOpenNode, onAuthLost }: Props) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingLimits, setSavingLimits] = useState(false);
  const [limitsError, setLimitsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const detail = await getRun(runId);
      setRun(detail);
      setFailure(null);
    } catch (err) {
      const classified = classifyError(err, "读取运行");
      if (classified.kind === "unauthorized") {
        onAuthLost();
        return;
      }
      setFailure(classified);
    } finally {
      setLoading(false);
    }
  }, [runId, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<number, NodeSummary[]>();
    for (const item of run?.nodes ?? []) {
      const bucket = map.get(item.depth) ?? [];
      bucket.push(item);
      map.set(item.depth, bucket);
    }
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  }, [run]);

  const readOnlyLimits = useMemo(
    () =>
      Object.entries(run?.limits ?? {}).filter(
        ([key]) => !(EDITABLE_LIMITS as readonly string[]).includes(key),
      ),
    [run],
  );

  const openLimits = () => {
    if (!run) return;
    const next: Record<string, string> = {};
    for (const key of EDITABLE_LIMITS) {
      const value = run.limits[key];
      next[key] = typeof value === "number" ? String(value) : "";
    }
    setDraft(next);
    setLimitsError(null);
    setLimitsOpen(true);
  };

  const saveLimits = async () => {
    if (!run) return;
    const changes: LimitChanges = {};
    for (const key of EDITABLE_LIMITS) {
      const raw = (draft[key] ?? "").trim();
      if (raw === "") continue;
      if (!/^\d+$/.test(raw)) {
        setLimitsError(`「${key}」必须是整数（现在是「${raw}」）。`);
        return;
      }
      const value = Number.parseInt(raw, 10);
      const current = typeof run.limits[key] === "number" ? (run.limits[key] as number) : null;
      if (current !== value) changes[key] = value;
    }
    if (Object.keys(changes).length === 0) {
      setLimitsOpen(false);
      setNotice({ kind: "ok", text: "没有需要提交的 limits 改动。" });
      return;
    }
    setSavingLimits(true);
    setLimitsError(null);
    try {
      const result = await changeRunLimits(run.id, changes);
      const summary = Object.entries(changes)
        .map(([key, value]) => `${key}=${value}（原 ${String(result.before?.[key] ?? "?")}）`)
        .join("、");
      setLimitsOpen(false);
      setNotice({ kind: "ok", text: `limits 已提交：${summary}。已回读运行详情。` });
      await load();
    } catch (err) {
      if (classifyError(err, "提交 limits").kind === "unauthorized") {
        onAuthLost();
        return;
      }
      setLimitsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingLimits(false);
    }
  };

  const doStop = async () => {
    if (!run) return;
    setStopping(true);
    setStopError(null);
    try {
      const result = await stopRun(run.id);
      setStopOpen(false);
      setNotice({ kind: "ok", text: `已请求停止（status=${result.status}）。已回读运行详情。` });
      await load();
    } catch (err) {
      if (classifyError(err, "停止运行").kind === "unauthorized") {
        onAuthLost();
        return;
      }
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  if (loading && !run) return <p className="empty">正在读取运行详情…</p>;

  if (failure && !run) {
    return (
      <div className="list">
        <section className={failure.kind === "board_unavailable" ? "notice notice--warn" : "notice notice--error"}>
          <h3 className="notice__title">
            {failure.kind === "board_unavailable" ? "研究看板暂不可用" : "打不开这个运行"}
          </h3>
          <p className="notice__body" role="alert">
            {failure.message}
          </p>
          <button type="button" className="btn" onClick={() => void load()}>
            重试
          </button>
        </section>
      </div>
    );
  }

  if (!run) return <p className="empty">没有数据。</p>;

  const stopDisabled = run.stop_requested || run.status === "stopping" || run.status === "done";

  return (
    <div className="list">
      {failure ? (
        <section className="notice notice--error">
          <p className="notice__body" role="alert">
            {failure.message}
          </p>
          <p className="notice__detail">下面是上一次成功读到的数据。</p>
          <button type="button" className="btn" onClick={() => void load()}>
            重试
          </button>
        </section>
      ) : null}

      <section className="panel">
        <h2 className="panel__question">{run.question}</h2>
        <div className="chip-row">
          <StatusChip status={run.status} />
          {run.phase ? <span className="chip chip--role">{run.phase}</span> : null}
          <span className="chip chip--tone-muted">节点 {run.node_count}</span>
          {run.awaiting_approval > 0 ? (
            <span className="badge badge--attention">待审批 {run.awaiting_approval}</span>
          ) : null}
          <span className="chip chip--tone-muted">更新 {formatRelativeMs(run.updated_at)}</span>
          {run.driver_active ? <span className="chip chip--tone-ok">driver 活跃</span> : <span className="chip chip--tone-muted">driver 空闲</span>}
          {run.stop_requested ? <span className="chip chip--tone-warn">已请求停止</span> : null}
        </div>
        <p className="panel__meta">
          <code>{run.id}</code> · <code>{run.workspace}</code>
        </p>
        {run.last_error ? <p className="panel__error">错误：{run.last_error}</p> : null}

        <div className="action-row">
          <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button type="button" className="btn" onClick={openLimits}>
            调整 limits
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              setStopError(null);
              setStopOpen(true);
            }}
            disabled={stopDisabled}
            title={stopDisabled ? "这个运行已经在停止或已结束" : "向运行发出 stop 请求"}
          >
            停止运行
          </button>
        </div>
        {stopDisabled ? <p className="panel__hint">停止按钮已禁用：运行已结束或已请求停止。</p> : null}
      </section>

      {notice ? (
        <section className={notice.kind === "ok" ? "notice notice--ok" : "notice notice--error"}>
          <p className="notice__body" role="status">
            {notice.text}
          </p>
        </section>
      ) : null}

      <section className="panel">
        <h3 className="panel__title">节点</h3>
        <p className="panel__hint">按 depth 分组；点一行进入节点详情（tasks / files / syntheses）。</p>
        {groups.length === 0 ? <p className="empty">这个运行还没有节点。</p> : null}
        {groups.map(([depth, nodes]) => (
          <div className="tree" key={depth}>
            <div className="tree__depth">depth {depth}</div>
            {nodes.map((item) => (
              <button
                key={item.id}
                type="button"
                className="node-row"
                style={{ paddingLeft: `${10 + Math.min(item.depth, 4) * 14}px` }}
                onClick={() => onOpenNode(item.id)}
              >
                <span className="node-row__id">{item.id}</span>
                <span className="node-row__meta">
                  <StatusChip status={item.status} />
                  {item.kind ? <span className="chip chip--role">{item.kind}</span> : null}
                  <span className={item.listening ? "chip chip--tone-ok" : "chip chip--tone-muted"}>
                    {item.listening ? "监听中" : "无监听"}
                  </span>
                  <span className="chip chip--tone-muted">合成 ×{item.syntheses}</span>
                </span>
                {item.question ? <span className="node-row__q">{item.question}</span> : null}
                {item.last_error ? <span className="node-row__err">{item.last_error}</span> : null}
              </button>
            ))}
          </div>
        ))}
      </section>

      <section className="panel">
        <h3 className="panel__title">limits</h3>
        <dl className="kv">
          {EDITABLE_LIMITS.map((key) => (
            <div className="kv__row" key={key}>
              <dt className="kv__key">{key}</dt>
              <dd className="kv__value">{String(run.limits[key] ?? "—")}</dd>
            </div>
          ))}
          {readOnlyLimits.map(([key, value]) => (
            <div className="kv__row kv__row--ro" key={key}>
              <dt className="kv__key">
                {key} <span className="chip chip--tone-muted">只读</span>
              </dt>
              <dd className="kv__value">{String(value ?? "—")}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="panel">
        <h3 className="panel__title">运行级产物</h3>
        {run.products.length === 0 ? (
          <p className="panel__hint">还没有产物。</p>
        ) : (
          <ul className="plain-list">
            {run.products.map((product) => (
              <li className="artifact-row" key={`${product.kind}-${product.path}`}>
                <span className="chip chip--role">{product.kind}</span>
                <span className="artifact-row__title">{product.title}</span>
                <span className="artifact-row__path">{product.path}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {run.dissolving.length > 0 ? (
        <section className="panel">
          <h3 className="panel__title">消解了研究问题的节点</h3>
          <div className="chip-row">
            {run.dissolving.map((nodeId) => (
              <span className="chip chip--tone-ok" key={nodeId}>
                {nodeId}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {stopOpen ? (
        <ConfirmLayer
          title="停止这个运行？"
          confirmLabel="确认停止"
          danger
          busy={stopping}
          error={stopError}
          onCancel={() => setStopOpen(false)}
          onConfirm={() => void doStop()}
        >
          <p className="sheet__text">
            将向 <code>{run.id}</code> 发出 <code>POST /api/runs/{"{"}id{"}"}/stop</code>。已完成的节点保留，
            未开始的节点不再启动；status 会变成 <code>stopping</code>。
          </p>
          <p className="sheet__text sheet__text--muted">这次调用会写入 audit.jsonl。</p>
        </ConfirmLayer>
      ) : null}

      {limitsOpen ? (
        <ConfirmLayer
          title="调整 limits"
          confirmLabel="提交"
          busy={savingLimits}
          error={limitsError}
          onCancel={() => setLimitsOpen(false)}
          onConfirm={() => void saveLimits()}
        >
          <p className="sheet__text">只允许这四个整数键；留空表示不改。提交后会回读运行详情。</p>
          <div className="limits-form">
            {EDITABLE_LIMITS.map((key) => (
              <label className="field" key={key}>
                <span className="field__label">
                  {key} <span className="field__hint">{LIMIT_HINT[key]}</span>
                </span>
                <input
                  className="field__input"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={draft[key] ?? ""}
                  onChange={(event) => setDraft((prev) => ({ ...prev, [key]: event.target.value }))}
                />
              </label>
            ))}
          </div>
        </ConfirmLayer>
      ) : null}
    </div>
  );
}
