import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { describeError, listCommands } from "../api";
import { completionQuery, isSlashCommand, matchesQuery, splitSuggestion } from "../command";

type Props = {
  onSend: (text: string) => Promise<void>;
  /** 单个 / 开头：走 POST /api/command 的桥接层，结果进本地气泡（不回落到 onSend）。 */
  onCommand: (text: string) => Promise<void>;
  disabled: boolean;
  disabledHint?: string;
  hint?: string;
};

const MAX_SUGGESTIONS = 6;

export default function Composer({ onSend, onCommand, disabled, disabledHint, hint }: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<string[] | null>(null);
  const [closed, setClosed] = useState(false);
  const [active, setActive] = useState(0);
  const [argHint, setArgHint] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [value]);

  const query = completionQuery(value);

  /* 补全目录只在真的要弹面板时取一次；取不到就不弹面板，补全永远不阻塞输入。 */
  useEffect(() => {
    if (query === null || catalog !== null) return;
    let alive = true;
    void listCommands()
      .then((list) => {
        if (alive) setCatalog(list);
      })
      .catch(() => {
        if (alive) setCatalog([]);
      });
    return () => {
      alive = false;
    };
  }, [query, catalog]);

  const suggestions = useMemo(() => {
    if (query === null || closed) return [];
    if (catalog === null) return [];
    return catalog.filter((item) => matchesQuery(item, query)).slice(0, MAX_SUGGESTIONS);
  }, [query, closed, catalog]);

  const showPanel = suggestions.length > 0;
  const cursor = active < suggestions.length ? active : 0;

  useEffect(() => {
    setActive(0);
  }, [query]);

  const pick = (suggestion: string) => {
    const { insertion, argHint: placeholder } = splitSuggestion(suggestion);
    setValue(insertion);
    setArgHint(placeholder || null);
    setClosed(true);
    setError(null);
    areaRef.current?.focus();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = value.trim();
    if (text === "" || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      // 单个 / 开头 → 桥接层解析；// 开头按上游约定原样发给模型。
      if (isSlashCommand(text)) await onCommand(text);
      else await onSend(text);
      // 只有服务端给出结果才清空输入框。
      setValue("");
      setArgHint(null);
    } catch (err) {
      // 投递未确认：显式报错 + 保留原文，绝不自动重发（CONTRACT §3）。
      setError(
        `投递未确认：${describeError(err)}。为避免重复投递，本条不会自动重发；请确认会话状态后手动再发。`,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      if (showPanel) {
        event.preventDefault();
        setClosed(true);
      }
      return;
    }
    if (showPanel && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setActive((prev) => {
        const last = suggestions.length - 1;
        const from = prev > last ? 0 : prev;
        const next = event.key === "ArrowDown" ? from + 1 : from - 1;
        return next < 0 ? last : next > last ? 0 : next;
      });
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    if ((event.nativeEvent as { isComposing?: boolean }).isComposing) return;
    event.preventDefault();
    // 面板开着且输入还只是前缀：Enter 先补全，别把半条命令发出去；已经和当前项一致就直接提交。
    const candidate = suggestions[cursor];
    if (showPanel && candidate !== undefined) {
      const exact = splitSuggestion(candidate).insertion.trimEnd() === value.trim();
      if (!exact) {
        pick(candidate);
        return;
      }
    }
    event.currentTarget.form?.requestSubmit();
  };

  const handleChange = (next: string) => {
    setValue(next);
    setClosed(false);
    setArgHint(null);
  };

  const doubleSlash = value.trimStart().startsWith("//");

  return (
    <form className="composer" onSubmit={submit}>
      {error ? (
        <p className="composer__error" role="alert">
          {error}
        </p>
      ) : null}
      {hint ? <p className="composer__hint">{hint}</p> : null}
      {doubleSlash ? (
        <p className="composer__hint">
          双斜杠：按上游约定原样发给模型，桥接层不解析成命令。
        </p>
      ) : null}

      {showPanel ? (
        <div className="composer__suggest" role="listbox" aria-label="斜杠命令补全">
          <p className="composer__suggest-head">命令 · ↑↓ 选择 · Enter 补全 · Esc 关闭</p>
          {suggestions.map((item, index) => {
            const parts = splitSuggestion(item);
            return (
              <button
                type="button"
                key={item}
                role="option"
                aria-selected={index === cursor}
                className={`composer__suggest-item${index === cursor ? " composer__suggest-item--active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(item)}
              >
                <span className="composer__suggest-cmd">{parts.insertion.trimEnd()}</span>
                {parts.argHint ? <span className="composer__suggest-arg">{parts.argHint}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {argHint ? <p className="composer__arg">下一个参数：{argHint}</p> : null}

      <div className="composer__row">
        <textarea
          ref={areaRef}
          className="composer__input"
          value={value}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={disabled ? (disabledHint ?? "当前会话不可输入") : "给 MISAKA 发消息…"}
          enterKeyHint="send"
          disabled={disabled}
          aria-label="消息输入框"
        />
        <button
          type="submit"
          className="btn btn--primary composer__send"
          disabled={disabled || busy || value.trim() === ""}
        >
          {busy ? "发送中…" : "发送"}
        </button>
      </div>
    </form>
  );
}
