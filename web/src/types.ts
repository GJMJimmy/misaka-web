/** CONTRACT §3 / §3.1 里冻结的类型，逐字对齐。 */
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

/* ------------------------------------------------------------------ M1 研究面 */

export type RunSummary = {
  id: string;
  question: string;
  workspace: string;
  status: string;
  phase?: string | null;
  stop_requested: boolean;
  driver_active: boolean;
  node_count: number;
  awaiting_approval: number;
  created_at: number;
  updated_at: number;
  last_error?: string | null;
};

export type NodeSummary = {
  id: string;
  question?: string | null;
  depth: number;
  status?: string | null;
  kind?: string | null;
  session_file?: string | null;
  listening: boolean;
  last_error?: string | null;
  created_at?: number | null;
  syntheses: number;
};

export type RunProduct = { kind: string; title: string; path: string };

export type RunDetail = RunSummary & {
  limits: Record<string, unknown>;
  nodes: NodeSummary[];
  products: RunProduct[];
  dissolving: string[];
};

export type NodeTask = {
  id: string;
  title?: string;
  status?: string;
  assignee?: string;
  kind?: string;
  round?: number;
  updated_at?: number;
};

export type NodeArtifact = { kind: string; title: string; path: string; created_at: number };
export type NodeSynthesis = { path: string; title: string; created_at: number };
export type NodeFile = { name: string; size: number; mtime: number };

/**
 * 注意：NodeSummary.syntheses 是「版本数」，NodeDetail.syntheses 是「版本列表」——
 * CONTRACT §3.1 里两者同名不同类型，所以这里用 Omit 覆盖而不是交叉类型。
 */
export type NodeDetail = Omit<NodeSummary, "syntheses"> & {
  run_id: string;
  tasks: NodeTask[];
  artifacts: NodeArtifact[];
  syntheses: NodeSynthesis[];
  files: NodeFile[];
};

export type RunFile = { name: string; text: string };

/** limits 里允许前端改的四个整数（CONTRACT §3.1）。 */
export const EDITABLE_LIMITS = ["sister_parallel", "parallel", "max_followups", "max_revisions"] as const;
export type EditableLimitKey = (typeof EDITABLE_LIMITS)[number];
export type LimitChanges = Partial<Record<EditableLimitKey, number>>;
