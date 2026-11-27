import { useState, type FormEvent } from "react";
import { createRun, isUnauthorized, setMockResearchMode } from "../api";
import { MOCK } from "../env";
import { CREATE_LIMIT_KEYS, type CreateRunLimits } from "../types";

type StartedResult = { runId: string | null; pid: number; workspace: string; log: string };

type Props = {
  onCancel: () => void;
  onStarted: (result: StartedResult) => void;
  onAuthLost: () => void;
};

/** 新建研究：问题必填（>=2 字），六个整数留空即不传，工作区留空用服务端默认。 */
export default function NewRunSheet({ onCancel, onStarted, onAuthLost }: Props) {
  const [question, setQuestion] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [diagnostics, setDiagnostics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mockNullRunId, setMockNullRunId] = useState(false);

  const questionLength = question.trim().length;

  const toggleMockNullRunId = async () => {
    const next = !mockNullRunId;
    try {
      await setMockResearchMode({ createRunIdNull: next });
      setMockNullRunId(next);
    } catch {
      setError("（mock）切换 run_id=null 演示开关失败。");
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    if (questionLength < 2) {
      setError("问题太短：至少要 2 个字。");
      return;
    }

    const limits: CreateRunLimits = {};
    for (const item of CREATE_LIMIT_KEYS) {
      const raw = (drafts[item.key] ?? "").trim();
      if (raw === "") continue; // 留空即不传
      if (!/^\d+$/.test(raw)) {
        setError(`「${item.flag}」必须是整数（现在是「${raw}」）。留空表示不传这个参数。`);
        return;
      }
      limits[item.key] = Number.parseInt(raw, 10);
    }

    const trimmedWorkspace = workspace.trim();
    const body = {
      question: question.trim(),
      ...(trimmedWorkspace === "" ? {} : { workspace: trimmedWorkspace }),
      ...(Object.keys(limits).length === 0 ? {} : { limits }),
      ...(diagnostics ? { diagnostics: true } : {}),
    };

    setBusy(true);
    setError(null);
    try {
      const result = await createRun(body);
      onStarted({
        runId: result.run_id ?? null,
        pid: result.pid,
        workspace: result.workspace,
        log: result.log,
      });
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      // 422 的 message 原样展示（工作区越界 / 问题太短 / 整数越界都由服务端说）
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="新建研究">
      <div className="sheet-layer__scrim" onClick={onCancel} />
      <form className="sheet sheet--form" onSubmit={submit}>
        <header className="sheet__head">
          <h2 className="sheet__title">新建研究</h2>
          <button type="button" className="btn btn--icon" onClick={onCancel} aria-label="关闭">
            ×
          </button>
        </header>

        <div className="sheet__body">
          <label className="field">
            <span className="field__label">
              研究问题 <span className="field__required">必填</span>
              <span className="field__hint">
                {questionLength}/2 字起
              </span>
            </span>
            <textarea
              className="field__input field__input--area"
              rows={4}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="要研究什么？例如：会话事件流的断线语义该怎么定？"
            />
          </label>

          <label className="field">
            <span className="field__label">
              工作区 <span className="field__hint">可选；留空会在工作区根下按问题自动建一个新的项目目录（不存在的路径也会自动创建）</span>
            </span>
            <input
              className="field__input"
              type="text"
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              placeholder="~/Documents/project-x（必须在 MISAKA_WEB_WORKSPACE_ROOT 之下；不存在会自动建）"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>

          <div className="field">
            <span className="field__label">
              参数 <span className="field__hint">留空即不传，对应 CLI 参数</span>
            </span>
            <div className="form-grid">
              {CREATE_LIMIT_KEYS.map((item) => (
                <label className="form-cell" key={item.key}>
                  <span className="form-cell__label">
                    {item.label}
                    <code className="form-cell__flag">{item.flag}</code>
                  </span>
                  <input
                    className="field__input"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    value={drafts[item.key] ?? ""}
                    onChange={(event) =>
                      setDrafts((prev) => ({ ...prev, [item.key]: event.target.value }))
                    }
                    placeholder={item.hint}
                  />
                </label>
              ))}
            </div>
          </div>

          <label className="switch">
            <input
              type="checkbox"
              className="switch__input"
              checked={diagnostics}
              onChange={(event) => setDiagnostics(event.target.checked)}
            />
            <span className="switch__track" aria-hidden="true">
              <span className="switch__knob" />
            </span>
            <span className="switch__label">
              诊断开关 <span className="field__hint">（--diagnostics，子进程会多打日志）</span>
            </span>
          </label>

          <p className="panel__hint">
            提交后服务端最多等 25s 让子进程把 run 写进看板：拿到 run_id 就直接跳到运行详情；
            拿不到说明进程已起、看板还没写进来，回到列表手动刷新即可。
          </p>
        </div>

        {error ? (
          <p className="msg-error sheet__error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="sheet__foot sheet__foot--wrap">
          {MOCK ? (
            <button
              type="button"
              className={`btn btn--chip${mockNullRunId ? " btn--chip-active" : ""}`}
              onClick={() => void toggleMockNullRunId()}
              disabled={busy}
            >
              mock: run_id {mockNullRunId ? "null" : "有"}
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? "启动中…" : "启动研究"}
          </button>
        </footer>
      </form>
    </div>
  );
}