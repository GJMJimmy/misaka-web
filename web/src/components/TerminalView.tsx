import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ApiError, createTerminalTicket, describeError, isUnauthorized } from "../api";
import {
  describeTerminalError,
  readXtermTheme,
  resolveTerminalWsUrl,
  watchThemeChange,
  type TerminalErrorCopy,
} from "../terminal";
import type { TerminalFrameIn, TerminalFrameOut, TerminalProfile, TerminalTicket } from "../types";

type Props = {
  mock: boolean;
  onAuthLost: () => void;
};

type Phase = "idle" | "ticket" | "connecting" | "open" | "closed" | "error";

const PROFILES: Array<{ id: TerminalProfile; label: string; hint: string }> = [
  { id: "shell", label: "shell", hint: "服务账号的登录 shell（$SHELL 或 /bin/bash -l），cwd 由下面决定。" },
  { id: "misaka", label: "misaka", hint: "misaka chat —— 和 Last Order 对话的交互式 TUI。" },
  { id: "panel", label: "panel", hint: "misaka panel —— 完整 TUI，手机上不推荐但可用。" },
  { id: "attach", label: "attach", hint: "misaka chat --attach --session <arg>：接到已存在的会话上。" },
];

/** 仅 mock 模式出现：让本地假后端复现每一个错误码（§3.8 界面要求 6）。 */
const MOCK_SCENES: Array<{ id: string; label: string }> = [
  { id: "normal", label: "正常（回显 / 缩放 / exit 0）" },
  { id: "too_many_terminals", label: "取票失败：429 并发超限" },
  { id: "pty_unavailable", label: "取票失败：501 无 PTY" },
  { id: "bad_profile", label: "取票失败：422 profile 不认识" },
  { id: "ticket_expired", label: "连上后：票据过期" },
  { id: "terminal_disabled", label: "连上后：终端被关掉" },
  { id: "drop", label: "无声断开（无 error 帧）" },
  { id: "exit1", label: "exit 帧：退出码 1" },
];

const IDLE_BANNER =
  "\x1b[2mMISAKA 终端（M7）· 选好 profile 后点「连接」\r\n" +
  "这里跑的是服务端的真终端，和上面的对话输入框互不影响。\x1b[0m\r\n\r\n";

/**
 * M7 终端页（CONTRACT §3.8）：取票 -> new WebSocket(ws_url) -> xterm 收发。
 * 页面本身不横向滚动；终端容器吃满可视区，visualViewport 变化时重新 fit 并发 resize。
 */
export default function TerminalView({ mock, onAuthLost }: Props) {
  const [profile, setProfile] = useState<TerminalProfile>("shell");
  const [cwd, setCwd] = useState("");
  const [arg, setArg] = useState("");
  const [scene, setScene] = useState("normal");
  const [phase, setPhase] = useState<Phase>("idle");
  const [size, setSize] = useState("");
  const [ticket, setTicket] = useState<TerminalTicket | null>(null);
  const [error, setError] = useState<TerminalErrorCopy | null>(null);
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(true);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const lastSizeRef = useRef("");

  const writeText = useCallback((text: string) => {
    termRef.current?.write(text);
  }, []);

  const send = useCallback((frame: TerminalFrameIn) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify(frame));
  }, []);

  /** fit 之后只在 cols/rows 真的变了时才发 resize，避免拖拽窗口时刷帧。 */
  const applyFit = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host) return;
    if (host.clientWidth < 24 || host.clientHeight < 24) return;
    try {
      fit.fit();
    } catch {
      return;
    }
    const key = `${term.cols}x${term.rows}`;
    if (key === lastSizeRef.current) return;
    lastSizeRef.current = key;
    setSize(key);
    const socket = socketRef.current;
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows } satisfies TerminalFrameIn));
    }
  }, []);

  const handleFrame = useCallback(
    (raw: unknown) => {
      if (typeof raw !== "string") return;
      let frame: TerminalFrameOut;
      try {
        frame = JSON.parse(raw) as TerminalFrameOut;
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;

      switch (frame.type) {
        case "output":
          if (typeof frame.data === "string") writeText(frame.data);
          return;
        case "exit": {
          const code = typeof frame.code === "number" ? frame.code : null;
          const signal = typeof frame.signal === "string" && frame.signal !== "" ? ` signal=${frame.signal}` : "";
          setExitCode(code);
          setPhase("closed");
          setNotice(null);
          writeText(`\r\n\x1b[2m── 进程已退出：退出码 ${code === null ? "未知" : code}${signal} ──\x1b[0m\r\n`);
          const socket = socketRef.current;
          socketRef.current = null;
          socket?.close();
          return;
        }
        case "error": {
          setError(describeTerminalError(frame.code, frame.message));
          setPhase("error");
          const socket = socketRef.current;
          socketRef.current = null;
          socket?.close();
          return;
        }
        case "pong":
        default:
          return;
      }
    },
    [writeText],
  );

  const closeQuietly = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
  }, []);

  const connect = useCallback(async () => {
    if (phase === "ticket" || phase === "connecting") return;
    closeQuietly();
    setError(null);
    setExitCode(undefined);
    setNotice(null);
    setTicket(null);
    setSize("");
    lastSizeRef.current = "";
    setPhase("ticket");
    termRef.current?.reset();

    let next: TerminalTicket;
    try {
      next = await createTerminalTicket({
        profile,
        ...(cwd.trim() === "" ? {} : { cwd: cwd.trim() }),
        ...(profile === "attach" && arg.trim() !== "" ? { arg: arg.trim() } : {}),
        ...(mock && scene !== "normal" ? { scene } : {}),
      });
    } catch (err) {
      if (isUnauthorized(err)) {
        onAuthLost();
        return;
      }
      if (err instanceof ApiError) setError(describeTerminalError(err.code, err.message));
      else setError(describeTerminalError("network_error", describeError(err)));
      setPhase("error");
      return;
    }

    setTicket(next);
    setPhase("connecting");
    const socket = new WebSocket(resolveTerminalWsUrl(next.ws_url));
    socketRef.current = socket;

    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      setPhase("open");
      setShowSetup(false);
      writeText(
        `\r\n\x1b[2m── 已连接：${next.profile}${next.cwd ? ` @ ${next.cwd}` : ""}${
          next.mode === "pipe" ? "（管道模式：没有 POSIX PTY）" : ""
        } ──\x1b[0m\r\n`,
      );
      applyFit();
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (socketRef.current === socket) handleFrame(ev.data);
    };
    socket.onerror = () => {
      if (socketRef.current !== socket) return;
      setNotice("WebSocket 报错：连接可能已被服务端断开。");
    };
    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setPhase((prev) => (prev === "error" || prev === "closed" ? prev : "closed"));
      setNotice((prev) => prev ?? "连接已断开（服务端关掉了 socket）。点「重连」重新取票。");
    };
  }, [phase, profile, cwd, arg, mock, scene, onAuthLost, writeText, applyFit, handleFrame, closeQuietly]);

  const disconnect = useCallback(() => {
    closeQuietly();
    setPhase("closed");
    setNotice("已主动断开。");
  }, [closeQuietly]);

  /* 建立终端本身：挂载、主题、fit、输入、清理。 */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      theme: readXtermTheme(),
      cursorBlink: true,
      scrollback: 2000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.write(IDLE_BANNER);
    termRef.current = term;
    fitRef.current = fit;

    const dataSub = term.onData((data: string) => send({ type: "input", data }));
    const stopTheme = watchThemeChange(() => {
      term.options.theme = readXtermTheme();
    });

    const refit = () => {
      window.requestAnimationFrame(() => applyFit());
    };
    const observer = new ResizeObserver(refit);
    observer.observe(host);
    window.visualViewport?.addEventListener("resize", refit);
    window.visualViewport?.addEventListener("scroll", refit);
    window.addEventListener("orientationchange", refit);
    document.addEventListener("visibilitychange", refit);
    const first = window.setTimeout(refit, 0);

    return () => {
      window.clearTimeout(first);
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", refit);
      window.visualViewport?.removeEventListener("scroll", refit);
      window.removeEventListener("orientationchange", refit);
      document.removeEventListener("visibilitychange", refit);
      stopTheme();
      dataSub.dispose();
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [send, applyFit]);

  /* 心跳：服务端有 pong，用来保活反代上的空闲连接。 */
  useEffect(() => {
    if (phase !== "open") return;
    const id = window.setInterval(() => send({ type: "ping" }), 25_000);
    return () => window.clearInterval(id);
  }, [phase, send]);

  const busy = phase === "ticket" || phase === "connecting";
  const connected = phase === "open";
  const profileHint = PROFILES.find((item) => item.id === profile)?.hint ?? "";

  const statusText =
    phase === "idle"
      ? "未连接"
      : phase === "ticket"
        ? "正在取票…"
        : phase === "connecting"
          ? "正在建立 WebSocket…"
          : phase === "open"
            ? `已连接 · ${ticket?.profile ?? profile}${size ? ` · ${size}` : ""}`
            : phase === "closed"
              ? "已断开"
              : "出错了";

  return (
    <div className="terminal">
      <p className="terminal__note">输入框里的文字会发给她；这里的按键会进终端。两者不是一回事。</p>

      {showSetup ? (
        <div className="terminal__setup">
          <div className="terminal__row">
            <label className="terminal__field">
              <span className="terminal__label">profile</span>
              <select
                className="field__input"
                value={profile}
                disabled={busy}
                onChange={(ev) => setProfile(ev.target.value as TerminalProfile)}
              >
                {PROFILES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="terminal__field terminal__field--wide">
              <span className="terminal__label">cwd（留空 = 服务端工作区根）</span>
              <input
                className="field__input"
                value={cwd}
                disabled={busy}
                onChange={(ev) => setCwd(ev.target.value)}
                placeholder="留空即工作区根"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
          </div>

          {profile === "attach" ? (
            <label className="terminal__field">
              <span className="terminal__label">arg：会话目录下的真实路径</span>
              <input
                className="field__input"
                value={arg}
                disabled={busy}
                onChange={(ev) => setArg(ev.target.value)}
                placeholder="例如 ~/.misaka/sessions/2024-.../agent"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
          ) : null}

          {mock ? (
            <label className="terminal__field">
              <span className="terminal__label">（mock）演示场景：下次点「连接」生效</span>
              <select
                className="field__input"
                value={scene}
                disabled={busy}
                onChange={(ev) => setScene(ev.target.value)}
              >
                {MOCK_SCENES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <div className="terminal__row">
            <button type="button" className="btn btn--primary" onClick={() => void connect()} disabled={busy}>
              {busy ? "连接中…" : connected ? "重新连接" : "连接"}
            </button>
            {connected ? (
              <button type="button" className="btn btn--chip" onClick={() => setShowSetup(false)}>
                收起设置
              </button>
            ) : null}
            <span className="terminal__hint">{profileHint}</span>
          </div>
        </div>
      ) : (
        <div className="terminal__row terminal__row--compact">
          <button type="button" className="btn btn--chip" onClick={() => setShowSetup(true)}>
            连接设置
          </button>
          <span className="terminal__hint">
            {profile}
            {ticket?.cwd ? ` @ ${ticket.cwd}` : ""}
          </span>
        </div>
      )}

      <div className="terminal__status">
        <span className={"terminal__dot" + (connected ? " terminal__dot--on" : "")} aria-hidden="true" />
        <span className="terminal__status-text">{statusText}</span>
        {exitCode !== undefined ? (
          <span className="terminal__exit">退出码 {exitCode === null ? "未知" : exitCode}</span>
        ) : null}
        {connected ? (
          <button type="button" className="btn btn--chip" onClick={disconnect}>
            断开
          </button>
        ) : (
          <button type="button" className="btn btn--chip" onClick={() => void connect()} disabled={busy}>
            重连
          </button>
        )}
      </div>

      {error ? (
        <div className="terminal__error" role="alert">
          <p className="terminal__error-title">{error.title}</p>
          <p className="terminal__error-hint">{error.hint}</p>
          {error.raw ? <p className="terminal__error-raw">{error.raw}</p> : null}
          <div className="terminal__row">
            <button type="button" className="btn btn--primary" onClick={() => void connect()}>
              重连
            </button>
            <button type="button" className="btn btn--chip" onClick={() => setError(null)}>
              收起
            </button>
          </div>
        </div>
      ) : null}

      {notice && !error ? (
        <p className="terminal__notice" role="status">
          {notice}
        </p>
      ) : null}

      <div
        className="terminal__box"
        ref={hostRef}
        onPointerDown={() => termRef.current?.focus()}
        aria-label="终端"
      />

      {ticket?.mode === "pipe" ? (
        <p className="terminal__hint">
          服务端是管道模式（Windows 没有 POSIX PTY）：只能跑非交互命令，TUI 不可用。
        </p>
      ) : null}
    </div>
  );
}
