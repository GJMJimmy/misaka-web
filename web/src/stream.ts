import { eventsUrl } from "./api";
import type { Delta, Snapshot, SSErrorPayload } from "./types";

export type StreamHandlers = {
  /** 连接建立（SSE open）。 */
  onOpen: () => void;
  /** 全量快照：连接建立后立即一次。 */
  onSnapshot: (snapshot: Snapshot) => void;
  /** 增量：entries 出现即表示有新条目；streaming 为当前流式片段。 */
  onDelta: (delta: Delta) => void;
  /** 服务端 `event: error` —— 会话失效/属主变更，调用方应停止且不自动重连。 */
  onServerError: (code: string, message: string) => void;
  /** 传输层错误（连接断开）—— 调用方应提示并等用户手动重连。 */
  onConnectionError: () => void;
  /** 事件体无法解析。 */
  onProtocolError: (message: string) => void;
};

export interface SessionStream {
  close: () => void;
}

function readData<T>(ev: Event): T | null {
  const data = (ev as MessageEvent<string>).data;
  if (typeof data !== "string" || data.length === 0) return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * 唯一的实时通道：EventSource 订阅 /api/sessions/{id}/events?since=<stream_cursor>。
 *
 * 关键策略（CONTRACT §3 / §6）：
 * - 任何错误都立刻 close()，浏览器因此不会自动重连；重连只能由用户点按钮触发。
 * - `error` 事件带 data 时是服务端的会话错误，不带 data 时是传输层断开。
 */
export function openSessionStream(
  sessionId: string,
  since: string | null,
  handlers: StreamHandlers,
): SessionStream {
  const source = new EventSource(eventsUrl(sessionId, since), { withCredentials: true });
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.addEventListener("open", () => {
    if (!closed) handlers.onOpen();
  });

  source.addEventListener("snapshot", (ev) => {
    if (closed) return;
    const snapshot = readData<Snapshot>(ev);
    if (snapshot) handlers.onSnapshot(snapshot);
    else handlers.onProtocolError("snapshot 事件体不是合法 JSON");
  });

  source.addEventListener("delta", (ev) => {
    if (closed) return;
    const delta = readData<Delta>(ev);
    if (delta) handlers.onDelta(delta);
    else handlers.onProtocolError("delta 事件体不是合法 JSON");
  });

  source.addEventListener("error", (ev) => {
    if (closed) return;
    const payload = readData<SSErrorPayload>(ev);
    close();
    if (payload && typeof payload.code === "string") {
      handlers.onServerError(payload.code, payload.message ?? "会话已失效");
      return;
    }
    handlers.onConnectionError();
  });

  return { close };
}
