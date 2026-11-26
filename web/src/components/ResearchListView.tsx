import { useCallback, useEffect, useState } from "react";
import { listRuns, setMockResearchMode } from "../api";
import { MOCK } from "../env";
import { classifyError, type LoadFailure } from "../errors";
import { formatRelativeMs } from "../format";
import type { RunSummary } from "../types";
import StatusChip from "./StatusChip";

type Props = { onOpen: (runId: string) => void; onAuthLost: () => void };

type MockMode = "normal" | "empty" | "board_unavailable";

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

export default function ResearchListView({ onOpen, onAuthLost }: Props) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [mockMode, setMockMode] = useState<MockMode>("normal");

  const load = useCallback(async () => {
    setLoading(true);
    setFailure(null);
    try {
      setRuns(await listRuns());
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
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const cycleMock = async () => {
    const next = NEXT_MODE[mockMode];
    try {
      await setMockResearchMode(next);
      setMockMode(next);
      await load();
    } catch {
      setFailure({ kind: "other", message: "（mock）切换演示状态失败。", raw: "" });
    }
  };

  const boardless = failure?.kind === "board_unavailable";

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
          <button type="button" className="btn btn--chip" onClick={() => void load()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      {boardless ? (
        <section className="notice notice--warn">
          <h3 className="notice__title">研究看板暂不可用</h3>
          <p className="notice__body">
            环境里没有找到可用的研究看板（<code>board_unavailable</code>）。装好 MISAKA、并至少创建过一次看板之后，
            点下面的「重试」。
          </p>
          <p className="notice__detail">{failure?.raw}</p>
          <button type="button" className="btn" onClick={() => void load()}>
            重试
          </button>
        </section>
      ) : null}

      {failure && !boardless ? (
        <section className="notice notice--error">
          <p className="notice__body" role="alert">
            {failure.message}
          </p>
          <button type="button" className="btn" onClick={() => void load()}>
            重试
          </button>
        </section>
      ) : null}

      {loading && runs.length === 0 && !failure ? <p className="empty">正在读取研究运行…</p> : null}

      {!loading && !failure && runs.length === 0 ? (
        <p className="empty">
          还没有研究运行。在任意会话里让 Last Order 调用 <code>misaka_research_start</code> 之后，这里会出现运行卡片。
        </p>
      ) : null}

      <ul className="cards">
        {runs.map((run) => (
          <li key={run.id}>
            <button type="button" className="card card--run" onClick={() => onOpen(run.id)}>
              <span className="card__top">
                <span className="card__title card__title--question">{run.question}</span>
              </span>
              <span className="card__meta">
                <StatusChip status={run.status} />
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
          </li>
        ))}
      </ul>
    </div>
  );
}
