import { useCallback, useEffect, useState } from "react";
import { ApiError, createProject, isUnauthorized, listProjects } from "../api";
import { classifyError, type LoadFailure } from "../errors";
import type { ProjectCreated, ProjectEntry } from "../types";
import ConfirmLayer from "./ConfirmLayer";

type Props = { onAuthLost: () => void; onGoResearch: () => void };

/** 项目（CONTRACT §3.7 界面要求 5）：列出工作区根下的目录，新建后显示 path 与 actions。 */
export default function SettingsProjects({ onAuthLost, onGoResearch }: Props) {
  const [root, setRoot] = useState("");
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<ProjectCreated | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [name, setName] = useState("");
  const [git, setGit] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await listProjects();
      setRoot(body.root);
      setProjects(body.projects);
      setFailure(null);
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      setFailure(classifyError(err, "读取项目列表"));
    } finally {
      setLoading(false);
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeSheet = () => {
    setSheetOpen(false);
    setConfirming(false);
    setSaveError(null);
  };

  const submit = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      const result = await createProject({ name: name.trim(), git });
      setCreated(result);
      setNotice("已建好 " + result.name + "：" + result.path);
      setSheetOpen(false);
      setConfirming(false);
      setName("");
      await load();
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      // 422 的 message 原样显示（重名 / 非空 / 非法名字）
      setSaveError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const flag = (on: boolean, onLabel: string, offLabel: string) => (
    <span className={"chip " + (on ? "chip--tone-ok" : "chip--tone-muted")}>{on ? onLabel : offLabel}</span>
  );

  return (
    <>
      <div className="list__toolbar">
        <h2 className="list__heading">项目</h2>
        <div className="list__actions">
          <button type="button" className="btn btn--chip" onClick={() => void load()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              setName("");
              setGit(true);
              setSaveError(null);
              setSheetOpen(true);
            }}
          >
            新建
          </button>
        </div>
      </div>

      <p className="panel__meta">
        工作区根：<span className="settings-ref">{root || "（服务端未返回）"}</span>。只有根下看起来像项目的目录会列出来。
      </p>

      {failure ? (
        <section className="notice notice--error">
          <p className="notice__body" role="alert">
            {failure.message}
          </p>
          <button type="button" className="btn" onClick={() => void load()}>
            重试
          </button>
        </section>
      ) : null}

      {notice ? (
        <section className="notice notice--ok">
          <p className="notice__body" role="status">
            {notice}
          </p>
        </section>
      ) : null}

      {created ? (
        <section className="panel">
          <h3 className="panel__title">已建好 {created.name}</h3>
          <p className="panel__meta">
            path：<span className="settings-ref">{created.path}</span>
          </p>
          {created.actions.length > 0 ? (
            <ul className="plain-list">
              {created.actions.map((action) => (
                <li className="settings-row__hint" key={action}>
                  {action}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="panel__hint">下一步：去「研究」里选这个工作区起一个 run。</p>
          <div className="settings-actions">
            <button type="button" className="btn btn--primary" onClick={onGoResearch}>
              去「研究」起 run
            </button>
            <button type="button" className="btn btn--chip" onClick={() => setCreated(null)}>
              收起
            </button>
          </div>
        </section>
      ) : null}

      {loading && projects.length === 0 && !failure ? <p className="empty">正在读取项目列表…</p> : null}
      {!loading && !failure && projects.length === 0 ? (
        <p className="empty">工作区根下还没有项目。新建一个，PROJECT.md 与 sources/ 会一起建好。</p>
      ) : null}

      <ul className="cards">
        {projects.map((project) => (
          <li className="panel" key={project.path}>
            <div className="card__top">
              <h3 className="panel__title">{project.name}</h3>
              <span className="chip">{project.runs} 个 run</span>
            </div>
            <div className="card__meta">
              {flag(project.is_git, "git", "无 git")}
              {flag(project.has_project_md, "PROJECT.md", "无 PROJECT.md")}
              {flag(project.has_sources, "sources/", "无 sources/")}
            </div>
            <p className="panel__meta">
              <span className="settings-ref">{project.path}</span>
            </p>
          </li>
        ))}
      </ul>

      {sheetOpen ? (
        <div className="sheet-layer" role="dialog" aria-modal="true" aria-label="新建项目">
          <div className="sheet-layer__scrim" onClick={closeSheet} />
          <form
            className="sheet sheet--form"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() === "") {
                setSaveError("名字不能为空。");
                return;
              }
              setSaveError(null);
              setConfirming(true);
            }}
          >
            <header className="sheet__head">
              <h2 className="sheet__title">新建项目</h2>
              <button type="button" className="btn btn--icon" onClick={closeSheet} aria-label="关闭">
                ×
              </button>
            </header>

            <div className="sheet__body">
              <label className="field">
                <span className="field__label">
                  名字 <span className="field__required">必填</span>
                </span>
                <input
                  className="field__input"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="文件夹名：字母、数字、中文、点、下划线、连字符"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>

              <label className="switch">
                <input
                  type="checkbox"
                  className="switch__input"
                  checked={git}
                  onChange={(event) => setGit(event.target.checked)}
                />
                <span className="switch__track" aria-hidden="true">
                  <span className="switch__knob" />
                </span>
                <span className="switch__label">是否 git init</span>
              </label>

              <p className="panel__hint">
                会在工作区根下建 <code>{name.trim() || "<名字>"}</code>，同时写一份 PROJECT.md 草稿与 sources/ 目录；
                名字必须是单个文件夹名。
              </p>
            </div>

            {saveError ? (
              <p className="msg-error sheet__error" role="alert">
                {saveError}
              </p>
            ) : null}

            <footer className="sheet__foot sheet__foot--wrap">
              <button type="button" className="btn" onClick={closeSheet} disabled={busy}>
                取消
              </button>
              <button type="submit" className="btn btn--primary" disabled={busy}>
                下一步
              </button>
            </footer>
          </form>
        </div>
      ) : null}

      {confirming ? (
        <ConfirmLayer
          title="建这个项目？"
          confirmLabel="新建"
          busy={busy}
          error={saveError}
          onConfirm={() => void submit()}
          onCancel={() => {
            setConfirming(false);
            setSaveError(null);
          }}
        >
          <p className="sheet__text">
            将在 <code>{root || "工作区根"}</code> 下创建 <code>{name.trim()}</code>
            {git ? "，并 git init。" : "，不 git init。"}
          </p>
          <p className="sheet__text sheet__text--muted">
            同时写一份 PROJECT.md 草稿与 sources/ 目录；重名或目标非空时服务端会拒绝，理由原样显示。
          </p>
        </ConfirmLayer>
      ) : null}
    </>
  );
}
