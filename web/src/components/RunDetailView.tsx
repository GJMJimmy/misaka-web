import { useCallback, useEffect, useMemo, useState } from "react";
import {
  changeRunLimits,
  getRun,
  getRunLog,
  isUnauthorized,
  resumeRun,
  setMockResearchMode,
  stopRun,
} from "../api";
import { MOCK } from "../env";
import { classifyError, type LoadFailure } from "../errors";
import { formatRelativeMs } from "../format";
import { printCurrentView } from "../print";
import {
  EDITABLE_LIMITS,
  type EditableLimitKey,
  type LimitChanges,
  type NodeSummary,
  type RunDetail,
} from "../types";
import ConfirmLayer from "./ConfirmLayer";
import LogSheet from "./LogSheet";
import SourceBrowser, { type SourceRequest } from "./SourceBrowser";
import StatusChip from "./StatusChip";

type Props = {
  runId: string;
  onOpenNode: (nodeId: string) => void;
  onAuthLost: () => void;
  flash?: string | null;
  onFlashHandled?: () => void;
};

type Notice = { kind: "ok" | "error"; text: string };
type MockProcessMode = "default" | "alive" | "dead" | "null";

const LIMIT_HINT: Record<EditableLimitKey, string> = {
  sister_parallel: "兄弟节点并行度（1..8）",
  parallel: "单个节点内并行度（1..8）",
  max_followups: "最多追问轮数（0..20）",
  max_revisions: "最多修订次数（0..10）",
};

/** 允许「恢复运行」的 status（CONTRACT §3.4 与 M2 说明；running 与 active 视为同类）。 */
const RESUME_STATUSES = new Set(["active", "running", "waiting_input", "stopping"]);

const NEXT_PROCESS_MODE: Record<MockProcessMode, MockProcessMode> = {
  default: "alive",
  alive: "dead",
  dead: "null",
  null: "default",
};

export default function RunDetailView({ runId, onOpenNode, onAuthLost, flash, onFlashHandled }: Props) {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [forcing, setForcing] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingLimits, setSavingLimits] = useState(false);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [log, setLog] = useState<{ path: string; text: string }>({ path: "", text: "" });
  const [mockProcess, setMockProcess] = useState<MockProcessMode>("default");
  const [browser, setBrowser] = useState<SourceRequest | null>(null);

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

  // 创建成功后带过来的提示：只消费一次。
  useEffect(() => {
    if (!flash) return;
    setNotice({ kind: "ok", text: flash });
    onFlashHandled?.();
  }, [flash, onFlashHandled]);

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

  const process = run?.process ?? null;
  const canResume = Boolean(process && !process.alive && RESUME_STATUSES.has(run?.status ?? ""));

  const resumeHint = (() => {
    if (!process) return "这个运行不是由 WebUI 启动的，没有可恢复的进程。";
    if (process.alive) return "进程还活着，不需要恢复。";
    if (!RESUME_STATUSES.has(run?.status ?? "")) {
      return `运行状态是「${run?.status ?? "未知"}」，不在 active / waiting_input / stopping 之内，不需要恢复。`;
    }
    return "进程已退出但运行还没结束：可以恢复（POST resume），恢复后回读状态。";
  })();

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
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      setLimitsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingLimits(false);
    }
  };

  const doStop = async (force: boolean) => {
    if (!run) return;
    if (force) setForcing(true);
    else setStopping(true);
    setStopError(null);
    try {
      const result = await stopRun(run.id, force);
      setStopOpen(false);
      const terminated = result.terminated;
      setNotice({
        kind: "ok",
        text: force
          ? `已请求停止并终止进程${
              terminated ? `（pid ${terminated.pid} ${terminated.ok ? "已终止" : "终止失败"}）` : "（没有可终止的进程）"
            }。已回读运行详情。`
          : `已请求停止（status=${result.status}）。已回读运行详情。`,
      });
      await load();
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setForcing(false);
      setStopping(false);
    }
  };

  const doResume = async () => {
    if (!run) return;
    setResumeBusy(true);
    try {
      const result = await resumeRun(run.id);
      setNotice({
        kind: "ok",
        text: `已恢复进程（kind=${result.kind}，pid ${result.pid}）。已回读运行详情。`,
      });
      await load();
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      setNotice({ kind: "error", text: `恢复失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setResumeBusy(false);
    }
  };

  const openLog = async () => {
    if (!run) return;
    setLogOpen(true);
    setLog({ path: process?.log ?? "", text: "" });
    setLogLoading(true);
    setLogError(null);
    try {
      const data = await getRunLog(run.id, 300);
      setLog({ path: data.path, text: data.text });
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      setLogError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogLoading(false);
    }
  };

  const cycleMockProcess = async () => {
    const next = NEXT_PROCESS_MODE[mockProcess];
    try {
      await setMockResearchMode({ process: next });
      setMockProcess(next);
      await load();
    } catch {
      setNotice({ kind: "error", text: "（mock）切换进程状态失败。" });
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
      <div className="print-header">
        <h1>{run.question}</h1>
        <p>
          运行 {run.id} · {run.workspace} · status {run.status}
        </p>
      </div>

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
          {run.driver_active ? (
            <span className="chip chip--tone-ok">driver 活跃</span>
          ) : (
            <span className="chip chip--tone-muted">driver 空闲</span>
          )}
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
          <button type="button" className="btn" onClick={() => setBrowser({})}>
            来源
          </button>
          <button type="button" className="btn" onClick={() => printCurrentView("page")}>
            导出/打印
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
        <h3 className="panel__title">进程</h3>
        {process ? (
          <>
            <dl className="kv">
              <div className="kv__row">
                <dt className="kv__key">pid</dt>
                <dd className="kv__value">
                  <code>{process.pid}</code>
                </dd>
              </div>
              <div className="kv__row">
                <dt className="kv__key">kind</dt>
                <dd className="kv__value">
                  <span className="chip chip--role">{process.kind}</span>
                </dd>
              </div>
              <div className="kv__row">
                <dt className="kv__key">alive</dt>
                <dd className="kv__value">
                  <span className={process.alive ? "badge badge--alive" : "badge badge--dead"}>
                    {process.alive ? "存活" : "已退出"}
                  </span>
                </dd>
              </div>
              <div className="kv__row">
                <dt className="kv__key">日志</dt>
                <dd className="kv__value kv__value--mono">{process.log}</dd>
              </div>
              <div className="kv__row">
                <dt className="kv__key">工作区</dt>
                <dd className="kv__value kv__value--mono">{process.workspace}</dd>
              </div>
              <div className="kv__row">
                <dt className="kv__key">启动</dt>
                <dd className="kv__value">{formatRelativeMs(process.started_at) || "—"}</dd>
              </div>
            </dl>

            {process.argv.length > 0 ? <pre className="argv-view">{process.argv.join(" ")}</pre> : null}

            <div className="action-row">
              <button type="button" className="btn" onClick={() => void openLog()}>
                查看日志
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => void doResume()}
                disabled={!canResume || resumeBusy}
                title={canResume ? "恢复（POST resume）" : resumeHint}
              >
                {resumeBusy ? "恢复中…" : "恢复运行"}
              </button>
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  setStopError(null);
                  setStopOpen(true);
                }}
                disabled={stopDisabled}
              >
                停止运行
              </button>
            </div>
            <p className="panel__hint">{resumeHint}</p>
          </>
        ) : (
          <p className="panel__hint">
            这个运行不是由 WebUI 启动的（外部 CLI 在跑或已结束）：没有进程信息，也没有终止进程的按钮。
            仍可以在看板层面「请求停止」。
          </p>
        )}

        {MOCK ? (
          <div className="chip-row">
            <button type="button" className="btn btn--chip" onClick={() => void cycleMockProcess()}>
              mock: 进程={mockProcess === "default" ? "跟随数据" : mockProcess}
            </button>
            <span className="panel__hint">（切换 RunDetail.process 的 alive / null 演示）</span>
          </div>
        ) : null}
      </section>

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
          confirmLabel="仅请求停止"
          danger
          busy={stopping}
          extraLabel={process ? "请求停止并终止进程" : undefined}
          extraBusy={forcing}
          extraDanger
          onExtra={process ? () => void doStop(true) : undefined}
          error={stopError}
          onCancel={() => setStopOpen(false)}
          onConfirm={() => void doStop(false)}
        >
          <p className="sheet__text">
            「仅请求停止」只写看板：<code>POST /api/runs/{"{"}id{"}"}/stop</code>，status 变成{" "}
            <code>stopping</code>，进程自己收尾。
          </p>
          {process ? (
            <p className="sheet__text sheet__text--muted">
              「请求停止并终止进程」还会发 <code>{"{"}force: true{"}"}</code> 终止 WebUI 托管的 pid{" "}
              <code>{process.pid}</code>。已完成的节点保留；审计会分别记 stop 与 terminate。
            </p>
          ) : (
            <p className="sheet__text sheet__text--muted">
              这个运行不是由 WebUI 启动的，没有可终止的进程，所以只提供「仅请求停止」。
            </p>
          )}
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

      {browser ? (
        <SourceBrowser
          runId={run.id}
          nodeId={null}
          initial={browser}
          onClose={() => setBrowser(null)}
          onAuthLost={onAuthLost}
        />
      ) : null}

      {logOpen ? (
        <LogSheet
          path={log.path}
          text={log.text}
          loading={logLoading}
          error={logError}
          onClose={() => {
            setLogOpen(false);
            setLogError(null);
          }}
        />
      ) : null}
    </div>
  );
}
