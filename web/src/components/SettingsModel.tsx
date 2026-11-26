import { useCallback, useEffect, useState } from "react";
import { ApiError, getModelSettings, isUnauthorized, saveModelSettings } from "../api";
import { classifyError, type LoadFailure } from "../errors";
import type { ModelSettings } from "../types";
import ConfirmLayer from "./ConfirmLayer";
import ModelPicker from "./ModelPicker";

type Props = { onAuthLost: () => void };

type Draft = { mode: "global" | "pin"; provider: string; model: string };
type Pending = { kind: "global" } | { kind: "role"; role: string };

const LAST_ORDER_ROLE = "last-order";
const SISTER_PREFIX = "sister:";

function roleLabel(role: string): string {
  if (role === LAST_ORDER_ROLE) return "Last Order（主脑）";
  if (role.startsWith(SISTER_PREFIX)) return "Sister #" + role.slice(SISTER_PREFIX.length);
  return role;
}

/** 角色覆盖写在角色的 settings.json 里：defaultProvider / defaultModel 都在才算钉死。 */
function pinnedOf(settings: Record<string, unknown>): { provider: string; model: string } {
  return {
    provider: typeof settings.defaultProvider === "string" ? settings.defaultProvider : "",
    model: typeof settings.defaultModel === "string" ? settings.defaultModel : "",
  };
}

/** 模型（CONTRACT §3.7 界面要求 2）：全局两级下拉 + 每个角色的覆盖，保存后回读。 */
export default function SettingsModel({ onAuthLost }: Props) {
  const [state, setState] = useState<ModelSettings | null>(null);
  const [globalDraft, setGlobalDraft] = useState<{ provider: string; model: string }>({
    provider: "",
    model: "",
  });
  const [roleDrafts, setRoleDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const apply = useCallback((next: ModelSettings) => {
    setState(next);
    const provider = next.global.provider ?? "";
    const model = next.global.model ?? "";
    setGlobalDraft({ provider, model });
    const drafts: Record<string, Draft> = {};
    for (const item of next.roles) {
      const pinned = pinnedOf(item.settings);
      drafts[item.role] =
        pinned.provider !== "" && pinned.model !== ""
          ? { mode: "pin", provider: pinned.provider, model: pinned.model }
          : { mode: "global", provider, model };
    }
    setRoleDrafts(drafts);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // 只读这一份（含 model_count）；模型目录由每个下拉在被选中时才各自去拉
      apply(await getModelSettings());
      setFailure(null);
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      setFailure(classifyError(err, "读取模型配置"));
    } finally {
      setLoading(false);
    }
  }, [apply, onAuthLost]);

  useEffect(() => {
    void load();
  }, [load]);

  const runSave = async (body: { provider: string; model: string; role?: string }) => {
    setBusy(true);
    setSaveError(null);
    try {
      const result = await saveModelSettings(body);
      setPending(null);
      setNotice(
        result.provider === ""
          ? roleLabel(result.role) + " 已改为跟随全局。"
          : "已保存：" + roleLabel(result.role) + " → " + result.provider + "/" + result.model,
      );
      await load();
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      // 422 的 message 原样显示（模型不在目录里 / 服务端不接受清空……）
      setSaveError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!pending) return;
    if (pending.kind === "global") return runSave({ provider: globalDraft.provider, model: globalDraft.model });
    const draft = roleDrafts[pending.role];
    if (!draft) return;
    // mode=global 传空 provider/model：让服务端把该角色自己的覆盖清掉（它不接受就原样显示 422）
    return runSave({
      provider: draft.mode === "global" ? "" : draft.provider,
      model: draft.mode === "global" ? "" : draft.model,
      role: pending.role,
    });
  };

  const pendingText = (() => {
    if (!pending) return null;
    if (pending.kind === "global") {
      return {
        title: "改全局默认模型？",
        confirmLabel: "写入全局",
        body:
          "将把全局默认模型改成 " +
          (globalDraft.provider || "?") +
          "/" +
          (globalDraft.model || "?") +
          "，写进 ~/.misaka/settings.json；已经跑起来的 run 不受影响。",
      };
    }
    const draft = roleDrafts[pending.role];
    if (!draft) return null;
    if (draft.mode === "global") {
      return {
        title: "改为跟随全局？",
        confirmLabel: "清掉覆盖",
        body:
          "将清掉 " +
          roleLabel(pending.role) +
          " 自己的模型覆盖，让它跟着全局（" +
          (globalDraft.provider || "?") +
          "/" +
          (globalDraft.model || "?") +
          "）走。服务端若不允许清空，它返回的 422 message 会原样出现在这里。",
      };
    }
    return {
      title: "钉到具体模型？",
      confirmLabel: "写入角色",
      body:
        "将把 " +
        roleLabel(pending.role) +
        " 固定到 " +
        (draft.provider || "?") +
        "/" +
        (draft.model || "?") +
        "，写进它自己的 settings.json。",
    };
  })();

  const updateRole = (role: string, patch: Partial<Draft>) => {
    setRoleDrafts((prev) => {
      const current = prev[role] ?? { mode: "global" as const, provider: "", model: "" };
      return { ...prev, [role]: { ...current, ...patch } };
    });
  };

  if (loading && !state) return <p className="empty">正在读取模型配置…</p>;

  return (
    <>
      <div className="list__toolbar">
        <h2 className="list__heading">模型</h2>
        <div className="list__actions">
          <button type="button" className="btn btn--chip" onClick={() => void load()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
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

      {state ? (
        <>
          <section className="panel">
            <h3 className="panel__title">全局默认</h3>
            <p className="panel__meta">
              当前：{(state.global.provider ?? "—") + "/" + (state.global.model ?? "—")} · thinking{" "}
              {state.global.thinking ?? "（未设置）"}
            </p>

            <ModelPicker
              providers={state.providers}
              provider={globalDraft.provider}
              model={globalDraft.model}
              onChange={setGlobalDraft}
              onAuthLost={onAuthLost}
            />

            <div className="action-row">
              <button
                type="button"
                className="btn btn--primary"
                disabled={globalDraft.provider === "" || globalDraft.model === ""}
                onClick={() => {
                  setSaveError(null);
                  setPending({ kind: "global" });
                }}
              >
                保存全局
              </button>
            </div>
          </section>

          <h3 className="panel__title">角色覆盖</h3>
          <p className="panel__meta">
            每个角色可以自己钉一个模型，或者跟着上面的全局默认走。role 就是 <code>last-order</code> /{" "}
            <code>sister:&lt;id&gt;</code>。
          </p>

          {state.roles.length === 0 ? <p className="empty">服务端没有返回任何角色。</p> : null}

          {state.roles.map((item) => {
            const draft = roleDrafts[item.role] ?? { mode: "global", provider: "", model: "" };
            const pinned = pinnedOf(item.settings);
            return (
              <section className="panel" key={item.role}>
                <h3 className="panel__title">{roleLabel(item.role)}</h3>
                <p className="panel__meta">
                  <code>{item.role}</code> · 当前{" "}
                  {pinned.provider !== "" && pinned.model !== ""
                    ? pinned.provider + "/" + pinned.model
                    : "跟随全局"}
                </p>

                <div className="chip-row" role="group" aria-label={item.role + " 的模型来源"}>
                  <button
                    type="button"
                    className={"btn btn--chip" + (draft.mode === "global" ? " btn--chip-active" : "")}
                    aria-pressed={draft.mode === "global"}
                    onClick={() => updateRole(item.role, { mode: "global" })}
                  >
                    跟随全局
                  </button>
                  <button
                    type="button"
                    className={"btn btn--chip" + (draft.mode === "pin" ? " btn--chip-active" : "")}
                    aria-pressed={draft.mode === "pin"}
                    onClick={() =>
                      updateRole(item.role, {
                        mode: "pin",
                        provider: draft.provider || globalDraft.provider,
                        model: draft.model || globalDraft.model,
                      })
                    }
                  >
                    具体 provider/model
                  </button>
                </div>

                {draft.mode === "pin" ? (
                  <ModelPicker
                    providers={state.providers}
                    provider={draft.provider}
                    model={draft.model}
                    onChange={(next) => updateRole(item.role, { provider: next.provider, model: next.model })}
                    onAuthLost={onAuthLost}
                  />
                ) : (
                  <p className="panel__hint">
                    保存后跟着全局走（{globalDraft.provider || "?"}/{globalDraft.model || "?"}）。
                  </p>
                )}

                <div className="action-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={draft.mode === "pin" && (draft.provider === "" || draft.model === "")}
                    onClick={() => {
                      setSaveError(null);
                      setPending({ kind: "role", role: item.role });
                    }}
                  >
                    保存
                  </button>
                </div>
              </section>
            );
          })}
        </>
      ) : null}

      {pendingText ? (
        <ConfirmLayer
          title={pendingText.title}
          confirmLabel={pendingText.confirmLabel}
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
