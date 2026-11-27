import { useCallback, useEffect, useState } from "react";
import {
  describeError,
  hideRun,
  hideStaleRuns,
  isUnauthorized,
  listRuns,
  setMockResearchMode,
  unhideRun,
} from "../api";
import { MOCK } from "../env";
import { classifyError, type LoadFailure } from "../errors";
import { formatRelativeMs } from "../format";
import type { RunSummary } from "../types";
import ConfirmLayer from "./ConfirmLayer";
import ItemMenuSheet from "./ItemMenuSheet";
import NewRunSheet from "./NewRunSheet";
import StatusChip from "./StatusChip";

type Props = {
  onOpen: (runId: string) => void;
  onCreatedRun: (runId: string, notice: string) => void;
  onAuthLost: () => void;
};

type MockMode = "normal" | "empty" | "board_unavailable";
type PendingStart = { pid: number; workspace: string; log: string };
type ActionKind = "hide" | "unhide" | "stale";

const MOCK_LABEL: Record<MockMode, string> = {
  normal: "mock: 正常",
  empty: "mock: 空态",
  board_unavailable: "mock: 503",
};

const NEXT_MODE: Record<MockMode, MockMode> = {
  normal: "empty",
  empty: "board_unavailable",
  board_unavailable: "normal",
};

export default function ResearchListView({ onOpen, onCreatedRun, onAuthLost }: Props) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [mockMode, setMockMode] = useState<MockMode>("normal");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pending, setPending] = useState<PendingStart | null>(null);
  /** CONTRACT §3.9：隐藏项默认不出现，开关打开时用 include_hidden=1 回读。 */
  const [showHidden, setShowHidden] = useState(false);
  const [menuRun, setMenuRun] = useState<RunSummary | null>(null);
  const [confirmStale, setConfirmStale] = useState(false);
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(
    async (includeHidden: boolean) => {
      setLoading(true);
      setFailure(null);
      try {
        setRuns(await listRuns(includeHidden));
      } catch (err) {
        const classified = classifyError(err, "读取研究运行");
        if (classified.kind === "unauthorized") {
          onAuthLost();
          return;
        }
        setRuns([]);
        setFailure(classified);
      } finally {
        setLoading(false);
      }
    },
    [onAuthLost],
  );

  useEffect(() => {
    void load(showHidden);
  }, [load, showHidden]);

  const reload = useCallback(() => load(showHidden), [load, showHidden]);

  const failAction = useCallback(
    (err: unknown, label: string) => {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      setActionError(`${label}失败：${describeError(err)}`);
    },
    [onAuthLost],
  );

  const cycleMock = async () => {
    const next = NEXT_MODE[mockMode];
    try {
      await setMockResearchMode({ mode: next });
      setMockMode(next);
      await reload();
    } catch {
      setFailure({ kind: "other", message: "（mock）切换演示状态失败。", raw: "" });
    }
  };

  const refreshBoard = async () => {
    setPending(null);
    await reload();
  };

  /** 隐藏 / 恢复：先按 id 调端点，再整表回读——不做乐观删除。 */
  const toggleRunVisibility = async (run: RunSummary) => {
    const kind: ActionKind = run.hidden === true ? "unhide" : "hide";
    setBusy(kind);
    setActionError(null);
    setFlash(null);
    try {
      if (kind === "hide") await hideRun(run.id);
      else await unhideRun(run.id);
      setMenuRun(null);
      await reload();
      setFlash(
        kind === "hide"
          ? "已从列表隐藏这条研究运行（MISAKA 里的数据没动，可恢复）。"
          : "已恢复显示这条研究运行。",
      );
    } catch (err) {
      failAction(err, kind === "hide" ? "隐藏" : "恢复显示");
    } finally {
      setBusy(null);
    }
  };

  const hideAllStale = async () => {
    setBusy("stale");
    setActionError(null);
    setFlash(null);
    try {
      const result = await hideStaleRuns();
      setConfirmStale(false);
      await reload();
      setFlash(
        result.added > 0
          ? `已隐藏 ${result.added} 条失效项（本服务累计隐藏 ${result.hidden} 条，可恢复）。`
          : "没有需要隐藏的失效项。",
      );
    } catch (err) {
      failAction(err, "隐藏所有失效项");
    } finally {
      setBusy(null);
    }
  };

  const boardless = failure?.kind === "board_unavailable";
  const staleCount = runs.filter((run) => run.workspace_missing === true && run.hidden !== true).length;

  return (
    <div className="list">
      <div className="list__toolbar">
        <h2 className="list__heading">研究</h2>
        <div className="list__actions">
          {MOCK ? (
            <button type="button" className="btn btn--chip" onClick={() => void cycleMock()}>
              {MOCK_LABEL[mockMode]}
            </button>
          ) : null}
          <button
            type="button"
            className={`btn btn--chip${showHidden ? " btn--chip-active" : ""}`}
            aria-pressed={showHidden}
            onClick={() => {
              setFlash(null);
              setActionError(null);
              setShowHidden(!showHidden);
            }}
          >
            显示已隐藏
          </button>
          <button type="button" className="btn btn--chip" onClick={() => void refreshBoard()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      <button type="button" className="btn btn--primary btn--block" onClick={() => setSheetOpen(true)}>
        新建研究
      </button>

      {staleCount > 0 ? (
        <div className="chip-row">
          <button
            type="button"
            className="btn btn--chip"
            onClick={() => {
              setActionError(null);
              setConfirmStale(true);
            }}
            disabled={busy !== null}
          >
            隐藏所有失效项（{staleCount}）
          </button>
          <span className="panel__hint">项目文件夹已不在磁盘上的研究运行。</span>
        </div>
      ) : null}

      {flash ? (
        <p className="panel__hint" role="status">
          {flash}
        </p>
      ) : null}

      {pending ? (
        <section className="notice notice--ok">
          <h3 className="notice__title">已启动，看板还没写进来</h3>
          <p className="notice__body">
            子进程 <code>pid {pending.pid}</code> 已启动，但在等待窗口内没把 run 写进看板
            （<code>run_id: null</code>）。稍后点「刷新看板」回读。
          </p>
          <p className="notice__detail">
            工作区 {pending.workspace} · 日志 {pending.log}
          </p>
          <button type="button" className="btn btn--primary" onClick={() => void refreshBoard()}>
            刷新看板
          </button>
        </section>
      ) : null}

      {boardless ? (
        <section className="notice notice--warn">
          <h3 className="notice__title">研究看板暂不可用</h3>
          <p className="notice__body">
            环境里没有找到可用的研究看板（<code>board_unavailable</code>）。装好 MISAKA、并至少创建过一次看板之后，
            点下面的「重试」。
          </p>
          <p className="notice__detail">{failure?.raw}</p>
          <button type="button" className="btn" onClick={() => void reload()}>
            重试
          </button>
        </section>
      ) : null}

      {failure && !boardless ? (
        <section className="notice notice--error">
          <p className="notice__body" role="alert">
            {failure.message}
          </p>
          <button type="button" className="btn" onClick={() => void reload()}>
            重试
          </button>
        </section>
      ) : null}

      {loading && runs.length === 0 && !failure ? <p className="empty">正在读取研究运行…</p> : null}

      {!loading && !failure && runs.length === 0 ? (
        <p className="empty">
          还没有研究运行。点上面的「新建研究」启动一个，或在任意会话里让 Last Order 调用{" "}
          <code>misaka_research_start</code>。之前隐藏过的项，打开上面的「显示已隐藏」就能找回来。
        </p>
      ) : null}

      <ul className="cards">
        {runs.map((run) => (
          <li key={run.id} className={`card-row${run.hidden ? " card-row--hidden" : ""}`}>
            <button type="button" className="card card--run" onClick={() => onOpen(run.id)}>
              <span className="card__top">
                <span className="card__title card__title--question">{run.question}</span>
              </span>
              <span className="card__meta">
                <StatusChip status={run.status} />
                {run.workspace_missing ? <span className="chip chip--tone-warn">项目文件已删除</span> : null}
                {run.hidden ? <span className="chip chip--tone-muted">已隐藏</span> : null}
                {run.stop_requested ? <span className="chip chip--tone-warn">停止中</span> : null}
                {run.phase ? <span className="chip chip--role">{run.phase}</span> : null}
                <span className="chip chip--tone-muted">节点 {run.node_count}</span>
                {run.awaiting_approval > 0 ? (
                  <span className="badge badge--attention">待审批 {run.awaiting_approval}</span>
                ) : null}
                <span className="card__time">{formatRelativeMs(run.updated_at)}</span>
              </span>
              {run.last_error ? <span className="card__cwd card__cwd--error">错误：{run.last_error}</span> : null}
              <span className="card__id">
                {run.id} · {run.workspace}
              </span>
            </button>
            <button
              type="button"
              className="btn btn--icon card-row__more"
              aria-label={`「${run.question}」的操作`}
              onClick={() => {
                setActionError(null);
                setMenuRun(run);
              }}
            >
              <span aria-hidden="true">⋯</span>
            </button>
          </li>
        ))}
      </ul>

      {menuRun ? (
        <ItemMenuSheet
          title="研究运行"
          subtitle={menuRun.question}
          error={actionError}
          actions={[
            menuRun.hidden === true
              ? {
                  label: "恢复显示",
                  meta: "重新出现在研究列表里；MISAKA 里的数据本来就没动过。",
                  busy: busy === "unhide",
                  disabled: busy !== null,
                  onSelect: () => void toggleRunVisibility(menuRun),
                }
              : {
                  label: "从列表隐藏",
                  meta: "只影响本服务的列表，MISAKA 里的数据不动，可恢复。",
                  busy: busy === "hide",
                  disabled: busy !== null,
                  onSelect: () => void toggleRunVisibility(menuRun),
                },
          ]}
          onClose={() => {
            if (busy !== null) return;
            setMenuRun(null);
            setActionError(null);
          }}
        />
      ) : null}

      {confirmStale ? (
        <ConfirmLayer
          title="隐藏所有失效项"
          confirmLabel={`隐藏 ${staleCount} 条`}
          busy={busy === "stale"}
          error={actionError}
          onConfirm={() => void hideAllStale()}
          onCancel={() => {
            setConfirmStale(false);
            setActionError(null);
          }}
        >
          <p className="sheet__text">
            这会把 <strong>{staleCount}</strong> 条「项目文件已删除」的研究运行从列表里隐藏。
          </p>
          <p className="sheet__text sheet__text--muted">
            只影响本服务的列表，MISAKA 里的数据不动，可恢复（打开「显示已隐藏」就能找回来）。
          </p>
        </ConfirmLayer>
      ) : null}

      {sheetOpen ? (
        <NewRunSheet
          onCancel={() => setSheetOpen(false)}
          onAuthLost={onAuthLost}
          onStarted={(result) => {
            setSheetOpen(false);
            if (result.runId) {
              onCreatedRun(
                result.runId,
                `研究已启动（pid ${result.pid}），看板已写入 run ${result.runId} —— 就是当前这一页。`,
              );
              return;
            }
            setPending({ pid: result.pid, workspace: result.workspace, log: result.log });
          }}
        />
      ) : null}
    </div>
  );
}
