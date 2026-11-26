import { useCallback, useEffect, useState } from "react";
import { getRunNode, tellRun } from "../api";
import { classifyError, type LoadFailure } from "../errors";
import { formatBytes, formatRelativeMs } from "../format";
import type { NodeDetail } from "../types";
import ConfirmLayer from "./ConfirmLayer";
import SourceBrowser, { type SourceRequest } from "./SourceBrowser";
import StatusChip from "./StatusChip";

type Props = { runId: string; nodeId: string; onAuthLost: () => void };
type Notice = { kind: "ok" | "error"; text: string };

const DEFAULT_TELL = "同意，按这份计划开始。";

export default function NodeDetailView({ runId, nodeId, onAuthLost }: Props) {
  const [node, setNode] = useState<NodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tellOpen, setTellOpen] = useState(false);
  const [tellText, setTellText] = useState(DEFAULT_TELL);
  const [telling, setTelling] = useState(false);
  const [tellError, setTellError] = useState<string | null>(null);
  const [browser, setBrowser] = useState<SourceRequest | null>(null);
  const [synthesisIndex, setSynthesisIndex] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const detail = await getRunNode(runId, nodeId);
      setNode(detail);
      setSynthesisIndex((prev) => {
        const last = Math.max(detail.syntheses.length - 1, 0);
        return prev <= last ? prev : last;
      });
      setFailure(null);
    } catch (err) {
      const classified = classifyError(err, "读取节点");
      if (classified.kind === "unauthorized") {
        onAuthLost();
        return;
      }
      setFailure(classified);
    } finally {
      setLoading(false);
    }
  }, [runId, nodeId, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const openTell = () => {
    setTellText(DEFAULT_TELL);
    setTellError(null);
    setTellOpen(true);
  };

  const submitTell = async () => {
    setTelling(true);
    setTellError(null);
    try {
      const result = await tellRun(runId, tellText, nodeId);
      setTellOpen(false);
      setNotice({
        kind: "ok",
        text: `已投递，需回读状态：node_id=${result.node_id}，session_id=${result.session_id}。投递 ≠ 开始，请点「回读状态」看节点是否转成 running。`,
      });
      await load();
    } catch (err) {
      if (classifyError(err, "投递").kind === "unauthorized") {
        onAuthLost();
        return;
      }
      // 422 的 message 原样展示（里面写着谁在监听）
      setTellError(err instanceof Error ? err.message : String(err));
    } finally {
      setTelling(false);
    }
  };

  if (loading && !node) return <p className="empty">正在读取节点详情…</p>;

  if (failure && !node) {
    return (
      <div className="list">
        <section className={failure.kind === "board_unavailable" ? "notice notice--warn" : "notice notice--error"}>
          <h3 className="notice__title">
            {failure.kind === "board_unavailable" ? "研究看板暂不可用" : "打不开这个节点"}
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

  if (!node) return <p className="empty">没有数据。</p>;

  const canTell = node.listening;
  const currentSynthesis = node.syntheses[synthesisIndex] ?? null;

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
        <h2 className="panel__question">{node.question ?? node.id}</h2>
        <div className="chip-row">
          <StatusChip status={node.status} />
          {node.kind ? <span className="chip chip--role">{node.kind}</span> : null}
          <span className="chip chip--tone-muted">depth {node.depth}</span>
          <span className={node.listening ? "chip chip--tone-ok" : "chip chip--tone-warn"}>
            {node.listening ? "监听中" : "无监听"}
          </span>
          <span className="chip chip--tone-muted">合成 ×{node.syntheses.length}</span>
          {formatRelativeMs(node.created_at) ? (
            <span className="chip chip--tone-muted">创建 {formatRelativeMs(node.created_at)}</span>
          ) : null}
        </div>
        <p className="panel__meta">
          <code>{node.run_id}</code> / <code>{node.id}</code>
          {node.session_file ? (
            <>
              {" · "}
              <code>{node.session_file}</code>
            </>
          ) : null}
        </p>
        {node.last_error ? <p className="panel__error">错误：{node.last_error}</p> : null}

        <div className="action-row">
          <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button type="button" className="btn" onClick={() => setBrowser({})}>
            来源
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={openTell}
            disabled={!canTell}
            title={canTell ? "把「同意」发给这个节点的 Last Order" : "节点没有监听者，无法投递"}
          >
            同意并开始
          </button>
        </div>
        {!canTell ? (
          <p className="panel__hint">
            按钮已禁用：这个节点 <code>listening=false</code> —— 没有 Last Order 在听，服务器会 422 并列出
            正在监听的节点（Listening now: …）。等节点重新挂上监听后再试。
          </p>
        ) : null}
      </section>

      {notice ? (
        <section className={notice.kind === "ok" ? "notice notice--ok" : "notice notice--error"}>
          <p className="notice__body" role="status">
            {notice.text}
          </p>
          <button type="button" className="btn" onClick={() => void load()}>
            回读状态
          </button>
        </section>
      ) : null}

      <section className="panel">
        <h3 className="panel__title">文件</h3>
        <p className="panel__hint">节点目录内的 .md/.txt；点开用自写 Markdown 渲染（代码块内部滚动）。</p>
        {node.files.length === 0 ? (
          <p className="panel__hint">这个节点还没有文件。</p>
        ) : (
          <ul className="plain-list">
            {node.files.map((entry) => (
              <li key={entry.name}>
                <button type="button" className="file-row" onClick={() => setBrowser({ path: entry.name })}>
                  <span className="file-row__name">{entry.name}</span>
                  <span className="file-row__meta">
                    {formatBytes(entry.size)}
                    {formatRelativeMs(entry.mtime) ? ` · ${formatRelativeMs(entry.mtime)}` : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {node.syntheses.length > 0 ? (
        <section className="panel">
          <h3 className="panel__title">合成（syntheses）</h3>
          <p className="panel__hint">
            {node.syntheses.length > 1
              ? "多版本：点版本号切换，默认最后一版。"
              : "只有一个版本。"}
          </p>
          <div className="chip-row">
            {node.syntheses.map((entry, index) => (
              <button
                key={entry.path}
                type="button"
                className={`btn btn--chip${index === synthesisIndex ? " btn--chip-active" : ""}`}
                onClick={() => {
                  setSynthesisIndex(index);
                  setBrowser({ path: entry.path });
                }}
              >
                v{index + 1}
              </button>
            ))}
          </div>
          {currentSynthesis ? (
            <p className="panel__meta">
              <code>{currentSynthesis.path}</code> · {currentSynthesis.title} ·{" "}
              {formatRelativeMs(currentSynthesis.created_at)}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="panel">
        <h3 className="panel__title">tasks</h3>
        {node.tasks.length === 0 ? (
          <p className="panel__hint">还没有任务。</p>
        ) : (
          <ul className="plain-list">
            {node.tasks.map((task) => (
              <li className="task-row" key={task.id}>
                <span className="task-row__title">{task.title ?? task.id}</span>
                <span className="task-row__meta">
                  <StatusChip status={task.status} />
                  {task.kind ? <span className="chip chip--role">{task.kind}</span> : null}
                  {task.assignee ? <span className="chip chip--tone-muted">{task.assignee}</span> : null}
                  {typeof task.round === "number" ? (
                    <span className="chip chip--tone-muted">round {task.round}</span>
                  ) : null}
                  {formatRelativeMs(task.updated_at) ? (
                    <span className="card__time">{formatRelativeMs(task.updated_at)}</span>
                  ) : null}
                </span>
                <span className="task-row__id">{task.id}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h3 className="panel__title">produced artifacts</h3>
        {node.artifacts.length === 0 ? (
          <p className="panel__hint">还没有产物。</p>
        ) : (
          <ul className="plain-list">
            {node.artifacts.map((artifact) => (
              <li className="artifact-row" key={`${artifact.kind}-${artifact.path}`}>
                <span className="chip chip--role">{artifact.kind}</span>
                <span className="artifact-row__title">{artifact.title}</span>
                <span className="artifact-row__path">{artifact.path}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {tellOpen ? (
        <ConfirmLayer
          title="同意并开始"
          confirmLabel="投递"
          busy={telling}
          error={tellError}
          onCancel={() => setTellOpen(false)}
          onConfirm={() => void submitTell()}
        >
          <p className="sheet__text">
            将把你的话发给这个节点的 <strong>Last Order</strong>（<code>{node.id}</code>），由她调用{" "}
            <code>misaka_research_start</code>。
          </p>
          <p className="sheet__text sheet__text--muted">
            这不是写看板，而是一次对话投递。发送成功只代表话已到位，<strong>不代表计划已开始</strong>——之后要回读节点状态。
          </p>
          <label className="field">
            <span className="field__label">要说的话（可编辑）</span>
            <textarea
              className="field__input field__input--area"
              rows={4}
              value={tellText}
              onChange={(event) => setTellText(event.target.value)}
            />
          </label>
          <p className="sheet__text sheet__text--muted">
            监听情况：{node.listening ? "有 Last Order 在听" : "没有 Last Order 在听（服务器会 422）"}
            {node.session_file ? `（${node.session_file}）` : ""}
          </p>
        </ConfirmLayer>
      ) : null}

      {browser ? (
        <SourceBrowser
          runId={runId}
          nodeId={nodeId}
          initial={browser}
          onClose={() => setBrowser(null)}
          onAuthLost={onAuthLost}
        />
      ) : null}
    </div>
  );
}
