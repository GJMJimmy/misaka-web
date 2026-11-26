import { useState, type FormEvent } from "react";
import { describeError } from "../api";
import { API_BASE_LABEL } from "../env";

type Props = {
  onSubmit: (token: string) => Promise<void>;
  mock: boolean;
};

export default function LoginView({ onSubmit, mock }: Props) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = token.trim();
    if (value === "" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login__brand">
        <span className="login__logo" aria-hidden="true">
          M
        </span>
        <h1 className="login__title">MISAKA WebUI</h1>
        <p className="login__subtitle">会话移动端控制台 · M0</p>
      </div>

      <form className="login__form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">访问 token</span>
          <input
            className="field__input"
            type="password"
            name="token"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="粘贴访问 token"
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            required
          />
        </label>

        {error ? (
          <p className="msg-error" role="alert">
            {error}
          </p>
        ) : null}

        <button type="submit" className="btn btn--primary btn--block" disabled={busy || token.trim() === ""}>
          {busy ? "登录中…" : "登录"}
        </button>

        <p className="login__foot">
          token 在服务器上
          <br />
          <code>~/.config/misaka-web/token</code>
        </p>

        <p className="login__foot">
          后端：<code>{API_BASE_LABEL}</code>
          {mock ? <span className="login__mock">· 本地 mock 模式（任意非空 token）</span> : null}
        </p>
      </form>
    </div>
  );
}
