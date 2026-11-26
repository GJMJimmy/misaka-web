import { useEffect, useRef, useState } from "react";
import { ApiError, getProviderModels, isUnauthorized } from "../api";
import type { Provider, ProviderModel } from "../types";

type Props = {
  providers: Provider[];
  provider: string;
  model: string;
  onChange: (next: { provider: string; model: string }) => void;
  /** true 时 provider 下拉的第一项是「跟随全局默认」（等价于空的 provider/model）。 */
  allowFollow?: boolean;
  followLabel?: string;
  disabled?: boolean;
  onAuthLost?: () => void;
};

/** provider/model 参考串（"deepseek/deepseek-chat"）的拆与合；空串 = 跟随全局。 */
export function splitModelRef(ref: string): { provider: string; model: string } {
  const cut = ref.indexOf("/");
  if (cut < 0) return { provider: ref, model: "" };
  return { provider: ref.slice(0, cut), model: ref.slice(cut + 1) };
}

export function joinModelRef(provider: string, model: string): string {
  if (provider === "") return "";
  return model === "" ? provider + "/" : provider + "/" + model;
}

/**
 * 两级 provider → model 下拉（CONTRACT §3.7 界面要求 2）。
 *
 * 模型目录**只在选中某个 provider 时才拉**，并按 provider id 缓存（缓存在 api.ts）。
 * 因此进入设置页只会为「当前真的在用」的那一两个 provider 发请求，不会一次性预取全部；
 * provider 条目若自带 \`models\`（契约形状），则连那一次请求都省掉。
 */
export default function ModelPicker({
  providers,
  provider,
  model,
  onChange,
  allowFollow = false,
  followLabel = "跟随全局默认",
  disabled = false,
  onAuthLost,
}: Props) {
  const [loaded, setLoaded] = useState<ProviderModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 目录回来时若还没选模型，落到第一个（老的自动选中行为保持不变）。
  const modelRef = useRef(model);
  modelRef.current = model;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    let alive = true;
    if (provider === "") {
      setLoaded(null);
      setError(null);
      setLoading(false);
      return;
    }
    // 契约形状（providers[].models 直接带着目录）时就地取用：不花任何请求
    const inline = providers.find((item) => item.id === provider)?.models;
    if (Array.isArray(inline) && inline.length > 0) {
      setLoaded(inline);
      setLoading(false);
      setError(null);
      if (modelRef.current === "") changeRef.current({ provider, model: inline[0].id });
      return;
    }
    setLoading(true);
    setError(null);
    getProviderModels(provider)
      .then((models) => {
        if (!alive) return;
        setLoaded(models);
        if (modelRef.current === "" && models.length > 0) {
          changeRef.current({ provider, model: models[0].id });
        }
      })
      .catch((err) => {
        if (!alive) return;
        if (isUnauthorized(err) && onAuthLost) {
          onAuthLost();
          return;
        }
        setLoaded(null);
        // 422 的 message 原样显示（例如「Unknown provider: xxx」）
        setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [provider, providers, onAuthLost]);

  const known = loaded ?? [];
  const currentOutsideCatalog = model !== "" && !known.some((item) => item.id === model);
  const options: ProviderModel[] = currentOutsideCatalog
    ? known.concat([{ id: model, name: model + "（当前值，不在目录里）" }])
    : known;
  const placeholder = loading
    ? "载入模型…"
    : known.length === 0 && model === ""
      ? "（这个 provider 没有可选模型）"
      : "（选择模型）";

  return (
    <>
      <label className="field">
        <span className="field__label">Provider</span>
        <select
          className="field__input"
          value={provider}
          disabled={disabled}
          onChange={(event) => onChange({ provider: event.target.value, model: "" })}
        >
          <option value="">{allowFollow ? followLabel : "（未设置）"}</option>
          {providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.configured ? "" : " · 未配置密钥"}
            </option>
          ))}
        </select>
      </label>

      {provider === "" ? null : (
        <label className="field">
          <span className="field__label">
            Model
            {loading ? <span className="field__hint">载入模型…</span> : null}
          </span>
          <select
            className="field__input"
            value={model}
            disabled={disabled || loading}
            onChange={(event) => onChange({ provider, model: event.target.value })}
          >
            <option value="">{placeholder}</option>
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || item.id}
              </option>
            ))}
          </select>
        </label>
      )}

      {error ? (
        <p className="panel__error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
