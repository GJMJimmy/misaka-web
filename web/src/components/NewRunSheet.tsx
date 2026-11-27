import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  createRun,
  describeError,
  isUnauthorized,
  listProjects,
  setMockProjectsMode,
  setMockResearchMode,
} from "../api";
import { MOCK } from "../env";
import { CREATE_LIMIT_KEYS, type CreateRunLimits, type ProjectEntry } from "../types";

type StartedResult = { runId: string | null; pid: number; workspace: string; log: string };

type Props = {
  onCancel: () => void;
  onStarted: (result: StartedResult) => void;
  onAuthLost: () => void;
};

/** 工作区从哪儿来：已有项目 / 让服务端按问题新建 / 手填路径（§3.7 + §3.4）。 */
type WorkspaceMode = "project" | "new" | "manual";

const MODE_LABEL: Record<WorkspaceMode, string> = {
  project: "项目",
  new: "新建项目目录",
  manual: "手动输入路径",
};

const MODES: WorkspaceMode[] = ["project", "new", "manual"];

const INTEGER = /^\d+$/;

/**
 * 新建研究：问题必填（>=2 字），六个整数留空即不传。
 * 工作区默认落在最近用过的项目里（GET /api/projects 的 default_project），
 * 不再默认跑到工作区根下新建目录——那只有当用户明确选「新建项目目录」时才发生。
 */
export default function NewRunSheet({ onCancel, onStarted, onAuthLost }: Props) {
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<WorkspaceMode>("project");
  const [workspace, setWorkspace] = useState("");
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [root, setRoot] = useState("");
  const [defaultProject, setDefaultProject] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsNote, setProjectsNote] = useState<string | null>(null);
  const [mockProjectsEmpty, setMockProjectsEmpty] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [diagnostics, setDiagnostics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mockNullRunId, setMockNullRunId] = useState(false);

  const questionLength = question.trim().length;

  /** 拉项目列表；失败就退到「手动输入路径」，绝不阻塞起 run。 */
  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const body = await listProjects();
      const names = new Set(body.projects.map((item) => item.name));
      const fallback = body.default_project && names.has(body.default_project) ? body.default_project : null;
      setRoot(body.root);
      setProjects(body.projects);
      setDefaultProject(fallback);
      setProjectName((prev) => (prev !== "" && names.has(prev) ? prev : (fallback ?? body.projects[0]?.name ?? "")));
      setProjectsNote(null);
      setMode((prev) => (body.projects.length === 0 ? "new" : prev === "manual" ? "manual" : "project"));
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      setProjects([]);
      setProjectName("");
      setProjectsNote(`读取项目列表失败（${describeError(err)}），已退到「手动输入路径」——不影响起 run。`);
      setMode("manual");
    } finally {
      setProjectsLoading(false);
    }
  }, [onAuthLost]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const toggleMockNullRunId = async () => {
    const next = !mockNullRunId;
    try {
      await setMockResearchMode({ createRunIdNull: next });
      setMockNullRunId(next);
    } catch {
      setError("（mock）切换 run_id=null 演示开关失败。");
    }
  };

  const toggleMockProjects = async () => {
    const next = !mockProjectsEmpty;
    try {
      await setMockProjectsMode(next ? "empty" : "default");
      setMockProjectsEmpty(next);
      setError(null);
      await loadProjects();
    } catch {
      setError("（mock）切换项目列表演示状态失败。");
    }
  };

  const selectMode = (next: WorkspaceMode) => {
    setMode(next);
    setError(null);
  };

  const selectedProject = projects.find((item) => item.name === projectName) ?? null;
  const manualPath = workspace.trim();
  const rootLabel = root === "" ? "工作区根" : root;
  /** 服务端「按问题新建」时用的目录形状：<时间戳>-<问题>/。 */
  const autoDirPath = `${rootLabel}/<时间戳>-<问题>/`;
  const previewPath =
    mode === "project"
      ? (selectedProject?.path ?? (projectName === "" ? "" : `${rootLabel}/${projectName}`))
      : mode === "new"
        ? autoDirPath
        : manualPath === ""
          ? autoDirPath
          : manualPath;

  /** 相对名（项目名）能直接被服务端解析到工作区根下；「新建」模式一个字节都不传。 */
  const workspaceForRequest = mode === "project" ? projectName.trim() : mode === "new" ? "" : manualPath;

  const invalidDrafts = CREATE_LIMIT_KEYS.filter((item) => {
    const raw = (drafts[item.key] ?? "").trim();
    return raw !== "" && !INTEGER.test(raw);
  });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;

    if (questionLength < 2) {
      setError("问题太短：至少要 2 个字。");
      return;
    }

    if (invalidDrafts.length > 0) {
      const first = invalidDrafts[0];
      const raw = (drafts[first.key] ?? "").trim();
      setError(`「${first.flag}」必须是整数（现在是「${raw}」）。留空表示不传这个参数。`);
      return;
    }

    if (mode === "project" && workspaceForRequest === "") {
      setError(
        projectsLoading
          ? "项目列表还在读取，稍等一下；或改用「新建项目目录」/「手动输入路径」。"
          : "请选一个项目；或改用「新建项目目录」让服务端按问题建目录。",
      );
      return;
    }

    const limits: CreateRunLimits = {};
    for (const item of CREATE_LIMIT_KEYS) {
      const raw = (drafts[item.key] ?? "").trim();
      if (raw === "") continue; // 留空即不传
      limits[item.key] = Number.parseInt(raw, 10);
    }

    const body = {
      question: question.trim(),
      ...(workspaceForRequest === "" ? {} : { workspace: workspaceForRequest }),
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
              <span className="field__hint">{questionLength}/2 字起</span>
            </span>
            <textarea
              className="field__input field__input--area"
              rows={4}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="要研究什么？例如：会话事件流的断线语义该怎么定？"
            />
          </label>

          <div className="field">
            <span className="field__label">
              工作区 <span className="field__hint">研究在哪个目录里跑</span>
            </span>

            <div className="chip-row" role="group" aria-label="工作区来源">
              {MODES.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`btn btn--chip${mode === item ? " btn--chip-active" : ""}`}
                  aria-pressed={mode === item}
                  onClick={() => selectMode(item)}
                  disabled={item === "project" && !projectsLoading && projects.length === 0}
                >
                  {MODE_LABEL[item]}
                </button>
              ))}
            </div>

            {projectsNote ? <p className="field__hint">{projectsNote}</p> : null}

            {mode === "project" ? (
              projectsLoading ? (
                <p className="field__hint">正在读取项目列表…</p>
              ) : projects.length === 0 ? (
                <p className="field__hint">
                  工作区根下还没有项目目录：用「新建项目目录」让服务端按问题建一个，或先到设置里新建项目。
                </p>
              ) : (
                <select
                  className="field__input"
                  aria-label="项目"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                >
                  {projects.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name} · {item.runs} 个 run{item.initialized === false ? " · 未初始化" : ""}
                      {item.name === defaultProject ? " · 最近使用" : ""}
                    </option>
                  ))}
                </select>
              )
            ) : null}

            {mode === "new" ? (
              <p className="field__hint">
                不传 workspace：服务端会在工作区根下按问题新建 <code>&lt;时间戳&gt;-&lt;问题&gt;/</code>{" "}
                并为它写 PROJECT.md。
              </p>
            ) : null}

            {mode === "manual" ? (
              <input
                className="field__input"
                type="text"
                value={workspace}
                onChange={(event) => setWorkspace(event.target.value)}
                placeholder="my-research（项目名，相对工作区根）或 ~/Documents/project-x（绝对路径；不存在会自动建）"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            ) : null}

            <p className="workspace-preview">
              将使用：<code>{previewPath === "" ? "（先选一个项目）" : previewPath}</code>
            </p>
          </div>

          <div className="field">
            <span className="field__label">
              参数 <span className="field__hint">留空即不传，占位符是服务端默认值</span>
            </span>
            <div className="form-grid">
              {CREATE_LIMIT_KEYS.map((item) => {
                const raw = (drafts[item.key] ?? "").trim();
                const invalid = raw !== "" && !INTEGER.test(raw);
                return (
                  <label className="form-cell" key={item.key}>
                    <span className="form-cell__label">
                      {item.label}
                      <span className="field__hint">{item.hint}</span>
                      <code className="form-cell__flag">{item.flag}</code>
                    </span>
                    <input
                      className={`field__input${invalid ? " field__input--invalid" : ""}`}
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      value={drafts[item.key] ?? ""}
                      onChange={(event) =>
                        setDrafts((prev) => ({ ...prev, [item.key]: event.target.value }))
                      }
                      placeholder={item.fallback}
                      aria-invalid={invalid ? true : undefined}
                      aria-describedby={invalid ? `limit-error-${item.key}` : undefined}
                    />
                    {invalid ? (
                      <span className="field__error" id={`limit-error-${item.key}`}>
                        只能填整数，默认 {item.fallback}
                      </span>
                    ) : null}
                  </label>
                );
              })}
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
            <>
              <button
                type="button"
                className={`btn btn--chip${mockNullRunId ? " btn--chip-active" : ""}`}
                onClick={() => void toggleMockNullRunId()}
                disabled={busy}
              >
                mock: run_id {mockNullRunId ? "null" : "有"}
              </button>
              <button
                type="button"
                className={`btn btn--chip${mockProjectsEmpty ? " btn--chip-active" : ""}`}
                onClick={() => void toggleMockProjects()}
                disabled={busy}
              >
                mock: 项目 {mockProjectsEmpty ? "空" : "有"}
              </button>
            </>
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
