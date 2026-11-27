import { useRef, useCallback, useEffect, useState } from "react";
import {
  ApiError,
  cursorToParam,
  describeError,
  getSession,
  runCommand,
  sendInput,
  setPaused as requestPauseToggle,
} from "../api";
import { bubbleOf, errorBubble } from "../command";
import { mergeEntries } from "../merge";
import { openSessionStream, type SessionStream } from "../stream";
import type { CommandBubble, Delta, Entry, Session, SessionRunState, Snapshot } from "../types";
import Banner, { type BannerProps } from "./Banner";
import Composer from "./Composer";
import MessageList from "./MessageList";
import SourceBrowser, { type SourceRequest } from "./SourceBrowser";

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
  const [readOnly, setReadOnly] = useState(false);
  // 这个会话属于哪个 run（服务端从看板查出来的），以及打开的来源面板
  const [owner, setOwner] = useState<{ runId: string; nodeId: string | null } | null>(null);
  const [sources, setSources] = useState<SourceRequest | null>(null);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  // 斜杠命令的结果只活在这里：快照/delta 都不会带上它，刷新即消失（CONTRACT §3.8）。
  const [commandBubbles, setCommandBubbles] = useState<CommandBubble[]>([]);

  const retry = useCallback(() => setReconnectNonce((n) => n + 1), []);
  // 一轮结束时以属主为准重新对账：增量帧可能只带来「流式结束」，而最后那一版正文要靠快照
  // 才拿得到。没有这一步，长回复会停在半句话上，直到用户退出重进（快照才刷新）。
  const reconciling = useRef(false);

  const applySnapshot = useCallback((snapshot: Snapshot) => {
    setEntries(snapshot.entries ?? []);
    setStreaming(snapshot.streaming ?? null);
    setRunState(snapshot.state);
    setPaused(snapshot.paused);
    setSessionError(snapshot.error ?? null);
    setReadOnly(snapshot.read_only === true);
    // 一个不带 run_id 的增量帧不应该抹掉已知的归属（SSE 首帧与 GET 走的是同一份数据，
    // 但仍然以有值为准）
    if (snapshot.run_id) setOwner({ runId: snapshot.run_id, nodeId: snapshot.node_id ?? null });
  }, []);

  const reconcile = useCallback(async () => {
    if (reconciling.current) return;
    reconciling.current = true;
    try {
      applySnapshot(await getSession(sessionId));
    } catch {
      /* 对账失败就保留已渲染内容，下一次增量还会触发 */
    } finally {
      reconciling.current = false;
    }
  }, [sessionId, applySnapshot]);

  // delta 只追加/原位更新，绝不重排已渲染条目。
  const applyDelta = useCallback((delta: Delta) => {
    if (Array.isArray(delta.entries) && delta.entries.length > 0) {
      const incoming = delta.entries;
      setEntries((prev) => mergeEntries(prev, incoming));
    }
    if ("streaming" in delta) setStreaming(delta.streaming ?? null);
    if (delta.state) setRunState(delta.state);
    // 流式结束（或整轮转为 idle）时对齐一次属主状态：这是「看不到结尾」那个问题的收尾动作。
    const finished = ("streaming" in delta && delta.streaming == null) || delta.state === "idle";
    if (finished) void reconcile();
  }, [reconcile]);

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

  /* 单个 / 开头：走桥接层解析（POST /api/command），结果/错误都进本地气泡。
     这条路径不调用 sendInput——命令不进会话、不发模型，失败也不回落到发送。 */
  const handleCommand = async (text: string) => {
    try {
      const result = await runCommand(text);
      setCommandBubbles((prev) => [...prev, bubbleOf(text, result)]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onAuthLost();
      // 422 / 其他失败：服务端 message 原样写成错误气泡，绝不回落到发送。
      setCommandBubbles((prev) => [...prev, errorBubble(text, describeError(err))]);
    }
  };

  const canControl = !readOnly && (session?.has_control ?? true);

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
        {owner ? (
          <button
            type="button"
            className="btn btn--chip"
            onClick={() => setSources({ highlight: null })}
            title={`这次研究的来源清单（run ${owner.runId}${owner.nodeId ? " · 节点 " + owner.nodeId : ""}）`}
          >
            来源
          </button>
        ) : null}
      </div>

      {banner ? <Banner {...banner} /> : null}

      {sessionError ? (
        <Banner kind="warn" text={`会话报告错误：${sessionError}`} />
      ) : null}

      {!canControl ? (
        <Banner kind="info" text="本会话没有控制权：可以只读观察，不能发送输入或暂停。" />
      ) : null}

      <MessageList
        entries={entries}
        streaming={streaming}
        runState={runState}
        local={commandBubbles}
        onCitation={
          owner ? (span) => setSources({ citation: span }) : undefined
        }
      />
      {owner && sources ? (
        <SourceBrowser
          runId={owner.runId}
          nodeId={owner.nodeId}
          initial={sources}
          onClose={() => setSources(null)}
          onAuthLost={onAuthLost}
        />
      ) : null}

      <Composer
        onSend={handleSend}
        onCommand={handleCommand}
        disabled={!canControl}
        disabledHint={readOnly ? "这个会话已经结束，只能查看历史" : "本会话无控制权，只能只读"}
        hint={paused ? "会话已暂停：恢复后才会处理新输入。" : undefined}
      />
    </div>
  );
}