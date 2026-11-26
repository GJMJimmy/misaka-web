/** CONTRACT §3 里 M0 冻结的类型，逐字对齐。 */
export type SessionState = "live" | "saved";
export type SessionRunState = "idle" | "working";

export type Session = {
  id: string;
  role: string;
  cwd?: string | null;
  state: SessionState;
  title?: string | null;
  has_control: boolean;
  last_activity?: string | null;
};

/** 上游会话条目，原样透传（content 形状未知，渲染层做防御式处理）。 */
export type Entry = { role: string; content: unknown; ts?: string };

export type Snapshot = {
  id: string;
  cwd?: string | null;
  state: SessionRunState;
  paused: boolean;
  error?: string | null;
  workflow?: unknown;
  streaming: Entry | null;
  entries: Entry[] | null;
  cursor: unknown;
  stream_cursor: unknown;
};

export type Delta = {
  state?: SessionRunState;
  entries?: Entry[];
  streaming?: Entry | null;
  cursor?: unknown;
  stream_cursor?: unknown;
};

export type SSErrorPayload = { code: string; message: string };
