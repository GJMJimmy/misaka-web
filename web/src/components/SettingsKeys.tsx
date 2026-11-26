import { useCallback, useEffect, useState } from "react";
import { ApiError, deleteSettingsKey, getSettingsKeys, isUnauthorized, putSettingsKey } from "../api";
import { classifyError, type LoadFailure } from "../errors";
import type { KeyEntry } from "../types";
import ConfirmLayer from "./ConfirmLayer";

type Props = { onAuthLost: () => void };
type Pending = { kind: "save"; entry: KeyEntry } | { kind: "delete"; entry: KeyEntry };

const MIN_KEY_LENGTH = 8;

/** 密钥（CONTRACT §3.7 界面要求 3）：只有 hint，没有明文；写之前两层确认。 */
export default function SettingsKeys({ onAuthLost }: Props) {
  const [envPath, setEnvPath] = useState("");
  const [keys, setKeys] = useState<KeyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<KeyEntry | null>(null);
  /** 明文只活在这一格：type=password 的输入框，提交或关掉就清空，从不到别处去。 */
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const body = await getSettingsKeys();
      setEnvPath(body.path);
      setKeys(body.keys);
      setFailure(null);
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      setFailure(classifyError(err, "读取密钥列表"));
    } finally {
      setLoading(false);
    }
  }, [onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const closeSheet = () => {
    setEditing(null);
    setDraft("");
    setSaveError(null);
  };

  const openSheet = (entry: KeyEntry) => {
    setEditing(entry);
    setDraft("");
    setSaveError(null);
    setNotice(null);
  };

  const submit = async () => {
    if (!pending) return;
    setBusy(true);
    setSaveError(null);
    try {
      if (pending.kind === "save") {
        const result = await putSettingsKey(pending.entry.name, draft);
        setDraft("");
        setEditing(null);
        setNotice("已写入 " + pending.entry.label + "，新的 hint：" + (result.hint || "（空）"));
      } else {
        await deleteSettingsKey(pending.entry.name);
        setNotice("已从 env 文件里删掉 " + pending.entry.label + "。");
      }
      setPending(null);
      await load();
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      // 422 的 message 原样显示（名字不在白名单 / 值太短）
      setSaveError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const shownPath = envPath || "~/.misaka/.env";

  return (
    <>
      <div className="list__toolbar">
        <h2 className="list__heading">密钥</h2>
        <div className="list__actions">
          <button type="button" className="btn btn--chip" onClick={() => void load()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </div>

      <p className="panel__meta">
        白名单来自服务端；密钥只写进 <code>{shownPath}</code>（权限 0600）。这里永远只显示前 4 位 + 长度。
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

      {loading && keys.length === 0 && !failure ? <p className="empty">正在读取密钥状态…</p> : null}
      {!loading && !failure && keys.length === 0 ? <p className="empty">服务端没有返回任何可配置的密钥。</p> : null}

      {keys.length > 0 ? (
        <section className="panel">
          {keys.map((entry) => (
            <div className="settings-row" key={entry.name}>
              <div className="settings-row__head">
                <span className="settings-row__name">{entry.label}</span>
                {entry.configured ? (
                  <span className="chip chip--tone-ok">已设置 · {entry.source ?? "未知来源"}</span>
                ) : (
                  <span className="chip chip--tone-muted">未设置</span>
                )}
              </div>
              <p className="settings-row__hint">
                <code>{entry.name}</code>
                {entry.hint ? " · " + entry.hint : ""}
              </p>
              <div className="settings-actions">
                <button type="button" className="btn btn--chip" onClick={() => openSheet(entry)}>
                  {entry.configured ? "更换" : "设置"}
                </button>
                {entry.configured ? (
                  <button
                    type="button"
                    className="btn btn--chip btn--danger"
                    onClick={() => {
                      setSaveError(null);
                      setPending({ kind: "delete", entry });
                    }}
                  >
                    删除
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {editing ? (
        <div className="sheet-layer" role="dialog" aria-modal="true" aria-label={"设置 " + editing.label}>
          <div className="sheet-layer__scrim" onClick={closeSheet} />
          <form
            className="sheet sheet--form"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim().length < MIN_KEY_LENGTH) {
                setSaveError("太短了：至少要 " + MIN_KEY_LENGTH + " 个字符（服务端也会再校验）。");
                return;
              }
              setSaveError(null);
              setPending({ kind: "save", entry: editing });
            }}
          >
            <header className="sheet__head">
              <h2 className="sheet__title">
                {editing.configured ? "更换" : "设置"} {editing.label}
              </h2>
              <button type="button" className="btn btn--icon" onClick={closeSheet} aria-label="关闭">
                ×
              </button>
            </header>

            <div className="sheet__body">
              <label className="field">
                <span className="field__label">
                  {editing.name}
                  <span className="field__required">只写不读</span>
                </span>
                <input
                  className="field__input"
                  type="password"
                  autoComplete="new-password"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={"粘贴 " + editing.label + " 的密钥（至少 " + MIN_KEY_LENGTH + " 位）"}
                />
              </label>
              <p className="panel__hint">
                下一步会再确认一次：写进 <code>{shownPath}</code>，文件权限 0600。提交后这一格立刻清空，
                之后界面只回显前 4 位 + 长度。
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

      {pending ? (
        pending.kind === "save" ? (
          <ConfirmLayer
            title="写入 env 文件？"
            confirmLabel="确认写入"
            busy={busy}
            error={saveError}
            onConfirm={() => void submit()}
            onCancel={() => {
              setPending(null);
              setSaveError(null);
            }}
          >
            <p className="sheet__text">
              将把 {pending.entry.label} 的密钥写进 <code>{shownPath}</code>，文件权限 0600（只有服务器本机可读）。
            </p>
            <p className="sheet__text sheet__text--muted">
              明文只落在服务器磁盘上：这里之后只回显前 4 位 + 长度，不会再从接口读回来。
            </p>
          </ConfirmLayer>
        ) : (
          <ConfirmLayer
            title="删掉这个密钥？"
            confirmLabel="删除"
            danger
            busy={busy}
            error={saveError}
            onConfirm={() => void submit()}
            onCancel={() => {
              setPending(null);
              setSaveError(null);
            }}
          >
            <p className="sheet__text">
              将从 <code>{shownPath}</code> 里删掉 {pending.entry.name} 这一行；其它配置不动。
            </p>
            {pending.entry.source === "shell environment" ? (
              <p className="sheet__text sheet__text--muted">
                注意：这一项现在是 shell 环境变量给的，删掉 env 文件里的一行不会让它失效——要让它真的失效，
                得先清掉那个环境变量。
              </p>
            ) : null}
          </ConfirmLayer>
        )
      ) : null}
    </>
  );
}
