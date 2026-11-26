import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { describeError } from "../api";

type Props = {
  onSend: (text: string) => Promise<void>;
  disabled: boolean;
  disabledHint?: string;
  hint?: string;
};

export default function Composer({ onSend, disabled, disabledHint, hint }: Props) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [value]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = value.trim();
    if (text === "" || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(text);
      // 只有服务端返回 {ok:true} 才清空输入框。
      setValue("");
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
    if (event.key !== "Enter" || event.shiftKey) return;
    if ((event.nativeEvent as { isComposing?: boolean }).isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <form className="composer" onSubmit={submit}>
      {error ? (
        <p className="composer__error" role="alert">
          {error}
        </p>
      ) : null}
      {hint ? <p className="composer__hint">{hint}</p> : null}
      <div className="composer__row">
        <textarea
          ref={areaRef}
          className="composer__input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
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
