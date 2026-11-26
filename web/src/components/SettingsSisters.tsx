import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  createSister,
  deleteSister,
  getModelSettings,
  isUnauthorized,
  listSisters,
  patchSister,
} from "../api";
import { classifyError, type LoadFailure } from "../errors";
import type { Provider, Sister } from "../types";
import ConfirmLayer from "./ConfirmLayer";
import ModelPicker, { joinModelRef, splitModelRef } from "./ModelPicker";

type Props = { onAuthLost: () => void };
type Editing = { mode: "create" } | { mode: "edit"; sister: Sister };
type Draft = { id: string; specialty: string; model: string; thinking: string };
type Pending = { kind: "save"; editing: Editing; draft: Draft } | { kind: "delete"; sister: Sister };

const ID_RE = /^[A-Za-z0-9][\w.-]{0,39}$/;

/** Sisters（CONTRACT §3.7 界面要求 4）：卡片 + 新建 / 编辑 / 删除，模型留空 = 跟随全局。 */
export default function SettingsSisters({ onAuthLost }: Props) {
  const [sisters, setSisters] = useState<Sister[]>([]);
  /** 只要 provider 列表（下拉的第一级）；模型目录由 ModelPicker 在被选中时才去拉。 */
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [drafts, setDrafts] = useState<Draft>({ id: "", specialty: "", model: "", thinking: "" });
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSisters(await listSisters());
      setFailure(null);
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      setFailure(classifyError(err, "读取 Sisters"));
    } finally {
      setLoading(false);
    }
    // provider 列表单独读：读不到就只留下「跟随全局」，不拖垮卡片列表，也绝不预取模型目录
    try {
      const state = await getModelSettings();
      setProviders(state.providers);
    } catch {
      setProviders([]);
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setDrafts({ id: "", specialty: "", model: "", thinking: "" });
    setSaveError(null);
    setEditing({ mode: "create" });
  };

  const openEdit = (sister: Sister) => {
    setDrafts({ id: sister.id, specialty: sister.specialty, model: sister.model, thinking: sister.thinking });
    setSaveError(null);
    setEditing({ mode: "edit", sister });
  };

  const closeSheet = () => {
    setEditing(null);
    setSaveError(null);
  };

  const submit = async () => {
    if (!pending) return;
    setBusy(true);
    setSaveError(null);
    try {
      if (pending.kind === "save") {
        if (pending.editing.mode === "create") {
          const body = {
            id: pending.draft.id.trim(),
            specialty: pending.draft.specialty.trim(),
            model: pending.draft.model,
            thinking: pending.draft.thinking.trim(),
          };
          const result = await createSister(body);
          setNotice("已新建 Sister " + result.id + "：" + result.message);
        } else {
          const result = await patchSister(pending.draft.id, {
            specialty: pending.draft.specialty,
            model: pending.draft.model,
            thinking: pending.draft.thinking,
          });
          setNotice(
            "已保存 Sister " + result.id + (result.changed.length > 0 ? "（改了 " + result.changed.join("、") + "）" : "（没有字段变化）"),
          );
        }
        setEditing(null);
      } else {
        const result = await deleteSister(pending.sister.id);
        setNotice("已删除 Sister " + result.id + "：" + result.message);
      }
      setPending(null);
      await load();
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      // 422 的 message 原样显示（id 不合法 / 重名 / 未注册 / confirmation_required）
      setSaveError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pendingText = (() => {
    if (!pending) return null;
    if (pending.kind === "delete") {
      return {
        title: "删除 Sister " + pending.sister.id + "？",
        confirmLabel: "删除",
        danger: true,
        body:
          "只删掉她的 profile 卡片目录与路由入口——她的卡片与会话会保留，看板上已经跑过的记录也都不动。",
      };
    }
    const id = pending.draft.id.trim();
    if (pending.editing.mode === "create") {
      return {
        title: "新建 Sister " + id + "？",
        confirmLabel: "新建",
        danger: false,
        body:
          "会在 ~/.misaka/profiles/" +
          id +
          " 建一张卡片" +
          (pending.draft.model === "" ? "，模型跟随全局默认。" : "，模型钉在 " + pending.draft.model + "。"),
      };
    }
    return {
      title: "保存对 Sister " + id + " 的修改？",
      confirmLabel: "保存",
      danger: false,
      body:
        "会重写她的专项描述与模型选择" +
        (pending.draft.model === "" ? "（模型跟随全局）" : "（模型钉在 " + pending.draft.model + "）") +
        "；已经跑起来的会话不受影响。",
    };
  })();

  const draftRef = splitModelRef(drafts.model);

  return (
    <>
      <div className="list__toolbar">
        <h2 className="list__heading">Sisters</h2>
        <div className="list__actions">
          <button type="button" className="btn btn--chip" onClick={() => void load()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
          <button type="button" className="btn btn--primary" onClick={openCreate}>
            新建
          </button>
        </div>
      </div>

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

      {loading && sisters.length === 0 && !failure ? <p className="empty">正在读取 Sisters…</p> : null}
      {!loading && !failure && sisters.length === 0 ? (
        <p className="empty">还没有 Sister 卡片。新建一张，主脑就能把她派出去。</p>
      ) : null}

      <ul className="cards">
        {sisters.map((sister) => (
          <li className="panel" key={sister.id}>
            <div className="card__top">
              <h3 className="panel__title">Sister #{sister.id}</h3>
              <span className="chip">{sister.model === "" ? "跟随全局" : "已钉模型"}</span>
            </div>
            <p className="panel__meta">
              模型：<span className="settings-ref">{sister.model === "" ? "跟随全局默认" : sister.model}</span>
            </p>
            <p className="panel__meta">
              thinking：<span className="settings-ref">{sister.thinking === "" ? "跟随全局默认" : sister.thinking}</span>
            </p>
            <p className="panel__hint">{sister.specialty === "" ? "还没有写专长。" : sister.specialty}</p>
            <div className="settings-actions">
              <button type="button" className="btn btn--chip" onClick={() => openEdit(sister)}>
                编辑
              </button>
              <button
                type="button"
                className="btn btn--chip btn--danger"
                onClick={() => {
                  setSaveError(null);
                  setPending({ kind: "delete", sister });
                }}
              >
                删除
              </button>
            </div>
          </li>
        ))}
      </ul>

      {editing ? (
        <div
          className="sheet-layer"
          role="dialog"
          aria-modal="true"
          aria-label={editing.mode === "create" ? "新建 Sister" : "编辑 Sister"}
        >
          <div className="sheet-layer__scrim" onClick={closeSheet} />
          <form
            className="sheet sheet--form"
            onSubmit={(event) => {
              event.preventDefault();
              const id = drafts.id.trim();
              if (editing.mode === "create") {
                if (!ID_RE.test(id)) {
                  setSaveError("ID 是短名字：字母或数字开头，只含字母、数字、点、下划线、连字符（最长 40）。");
                  return;
                }
                if (sisters.some((item) => item.id === id)) {
                  setSaveError("已经有一个同名 Sister 了。");
                  return;
                }
              }
              setSaveError(null);
              setPending({ kind: "save", editing, draft: drafts });
            }}
          >
            <header className="sheet__head">
              <h2 className="sheet__title">{editing.mode === "create" ? "新建 Sister" : "编辑 Sister " + drafts.id}</h2>
              <button type="button" className="btn btn--icon" onClick={closeSheet} aria-label="关闭">
                ×
              </button>
            </header>

            <div className="sheet__body">
              <label className="field">
                <span className="field__label">
                  ID <span className="field__required">必填</span>
                </span>
                <input
                  className="field__input"
                  type="text"
                  value={drafts.id}
                  disabled={editing.mode === "edit"}
                  onChange={(event) => setDrafts({ ...drafts, id: event.target.value })}
                  placeholder="10032（字母 / 数字 / 点 / 下划线 / 连字符）"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
              </label>

              <label className="field">
                <span className="field__label">
                  专长 <span className="field__hint">写进她卡片 description 的那句话</span>
                </span>
                <textarea
                  className="field__input field__input--area"
                  rows={4}
                  value={drafts.specialty}
                  onChange={(event) => setDrafts({ ...drafts, specialty: event.target.value })}
                  placeholder="例如：证据核对——交叉验证来源、页码与引用，宁可说「没找到」也不补全。"
                />
              </label>

              <div className="field">
                <span className="field__label">
                  模型 <span className="field__hint">provider 留空 = 跟随全局</span>
                </span>
                <ModelPicker
                  providers={providers}
                  provider={draftRef.provider}
                  model={draftRef.model}
                  allowFollow
                  followLabel="跟随全局默认（不钉死）"
                  onChange={(next) => setDrafts({ ...drafts, model: joinModelRef(next.provider, next.model) })}
                  onAuthLost={onAuthLost}
                />
              </div>

              <label className="field">
                <span className="field__label">
                  thinking <span className="field__hint">留空 = 跟随全局默认</span>
                </span>
                <input
                  className="field__input"
                  type="text"
                  list="misaka-thinking-levels"
                  value={drafts.thinking}
                  onChange={(event) => setDrafts({ ...drafts, thinking: event.target.value })}
                  placeholder="high"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <datalist id="misaka-thinking-levels">
                  <option value="low" />
                  <option value="medium" />
                  <option value="high" />
                </datalist>
              </label>
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

      {pendingText ? (
        <ConfirmLayer
          title={pendingText.title}
          confirmLabel={pendingText.confirmLabel}
          danger={pendingText.danger}
          busy={busy}
          error={saveError}
          onConfirm={() => void submit()}
          onCancel={() => {
            setPending(null);
            setSaveError(null);
          }}
        >
          <p className="sheet__text">{pendingText.body}</p>
        </ConfirmLayer>
      ) : null}
    </>
  );
}
