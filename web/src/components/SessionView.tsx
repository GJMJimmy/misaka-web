import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  cursorToParam,
  describeError,
  getSession,
  sendInput,
  setPaused as requestPauseToggle,
} from "../api";
import { mergeEntries } from "../merge";
import { openSessionStream, type SessionStream } from "../stream";
import type { Delta, Entry, Session, SessionRunState, Snapshot } from "../types";
import Banner, { type BannerProps } from "./Banner";
import Composer from "./Composer";
import MessageList from "./MessageList";

type ConnState = "connecting" | "open" | "closed";

type Props = {
  sessionId: string;
  session: Session | null;
  onBack: () => void;
  onAuthLost: () => void;
};

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "连接中",
  open: "已连接",
  closed: "已断开",
};

export default function SessionView({ sessionId, session, onBack, onAuthLost }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [streaming, setStreaming] = useState<Entry | null>(null);
  const [runState, setRunState] = useState<SessionRunState>("idle");
  const [paused, setPaused] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [banner, setBanner] = useState<BannerProps | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  const retry = useCallback(() => setReconnectNonce((n) => n + 1), []);

  const applySnapshot = useCallback((snapshot: Snapshot) => {
    setEntries(snapshot.entries ?? []);
    setStreaming(snapshot.streaming ?? null);
    setRunState(snapshot.state);
    setPaused(snapshot.paused);
    setSessionError(snapshot.error ?? null);
  }, []);

  // delta 只追加/原位更新，绝不重排已渲染条目。
  const applyDelta = useCallback((delta: Delta) => {
    if (Array.isArray(delta.entries) && delta.entries.length > 0) {
      const incoming = delta.entries;
      setEntries((prev) => mergeEntries(prev, incoming));
    }
    if ("streaming" in delta) setStreaming(delta.streaming ?? null);
    if (delta.state) setRunState(delta.state);
  }, []);

  /* 进入会话：先 GET 全量快照，再用 since=<stream_cursor> 订阅 SSE。
     reconnectNonce 变化 = 用户点了「重连」，是本组件唯一的重连触发源。 */
  useEffect(() => {
    let cancelled = false;
    let stream: SessionStream | null = null;
    setConn("connecting");
    setBanner(null);

    void (async () => {
      try {
        const snapshot = await getSession(sessionId);
        if (cancelled) return;
        applySnapshot(snapshot);
        stream = openSessionStream(sessionId, cursorToParam(snapshot.stream_cursor), {
          onOpen: () => {
            if (!cancelled) setConn("open");
          },
          onSnapshot: (next) => {
            if (!cancelled) applySnapshot(next);
          },
          onDelta: (delta) => {
            if (!cancelled) applyDelta(delta);
          },
          onServerError: (code, message) => {
            if (cancelled) return;
            setConn("closed");
            setBanner({
              kind: "error",
              text: `会话已失效（${code}）：${message} 实时流已停止，不会自动重连。`,
              actionLabel: "重试",
              onAction: retry,
            });
          },
          onConnectionError: () => {
            if (cancelled) return;
            setConn("closed");
            setBanner({
              kind: "warn",
              text: "与后端的实时连接已断开。不会自动重连，请手动重连（会从断点续订）。",
              actionLabel: "重连",
              onAction: retry,
            });
          },
          onProtocolError: (message) => {
            if (cancelled) return;
            setBanner({
              kind: "warn",
              text: `事件解析失败：${message}`,
              actionLabel: "重连",
              onAction: retry,
            });
          },
        });
        if (cancelled) stream.close();
      } catch (err) {
        if (cancelled) return;
        setConn("closed");
        if (err instanceof ApiError && err.status === 401) {
          onAuthLost();
          return;
        }
        setBanner({
          kind: "error",
          text: `加载会话失败：${describeError(err)}`,
          actionLabel: "重试",
          onAction: retry,
        });
      }
    })();

    return () => {
      cancelled = true;
      stream?.close();
    };
  }, [sessionId, reconnectNonce, applySnapshot, applyDelta, retry, onAuthLost]);

  const togglePause = async () => {
    if (pauseBusy) return;
    setPauseBusy(true);
    try {
      const next = await requestPauseToggle(sessionId, !paused);
      setPaused(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onAuthLost();
        return;
      }
      setBanner({
        kind: "error",
        text: `${paused ? "恢复" : "暂停"}失败：${describeError(err)}`,
      });
    } finally {
      setPauseBusy(false);
    }
  };

  const handleSend = async (text: string) => {
    try {
      await sendInput(sessionId, text);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      throw err;
    }
  };

  const canControl = session?.has_control ?? true;

  return (
    <div className="session">
      <div className="session__bar">
        <button type="button" className="btn btn--chip" onClick={onBack}>
          <span aria-hidden="true">←</span>
          <span>会话列表</span>
        </button>
        <span className={`chip chip--run chip--run-${runState}`}>
          {runState === "working" ? "处理中" : "空闲"}
        </span>
        <span className={`conn conn--${conn}`}>
          <span className="conn__dot" aria-hidden="true" />
          {CONN_LABEL[conn]}
        </span>
        <button
          type="button"
          className="btn btn--chip session__pause"
          onClick={() => void togglePause()}
          disabled={pauseBusy || !canControl}
        >
          {pauseBusy ? "…" : paused ? "恢复" : "暂停"}
        </button>
      </div>

      {banner ? <Banner {...banner} /> : null}

      {sessionError ? (
        <Banner kind="warn" text={`会话报告错误：${sessionError}`} />
      ) : null}

      {!canControl ? (
        <Banner kind="info" text="本会话没有控制权：可以只读观察，不能发送输入或暂停。" />
      ) : null}

      <MessageList entries={entries} streaming={streaming} runState={runState} />

      <Composer
        onSend={handleSend}
        disabled={!canControl}
        disabledHint="本会话无控制权，只能只读"
        hint={paused ? "会话已暂停：恢复后才会处理新输入。" : undefined}
      />
    </div>
  );
}
