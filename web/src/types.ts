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
  /** CONTRACT §3.4：null = 这个 run 不是本桥接启动的（外部 CLI 在跑或已结束）。 */
  process?: ProcessInfo | null;
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

/* ------------------------------------------------------- M2 进程托管（§3.4） */

export type ProcessInfo = {
  run_id: string;
  pid: number;
  argv: string[];
  workspace: string;
  kind: string; // "new" | "resume" | …
  log: string;
  started_at: number;
  alive: boolean;
};

/**
 * 新建研究时允许的六个整数键，一一对应 CLI 参数（CONTRACT §3.4 / 验收 3）：
 * --depth / --parallel / --sister-parallel / --followups / --revisions / --max-nodes
 */
export const CREATE_LIMIT_KEYS = [
  { key: "depth", flag: "--depth", label: "研究深度", hint: "1..5" },
  { key: "parallel", flag: "--parallel", label: "节点内并行度", hint: "1..8" },
  { key: "sister_parallel", flag: "--sister-parallel", label: "兄弟节点并行度", hint: "1..8" },
  { key: "followups", flag: "--followups", label: "追问轮数", hint: "0..20" },
  { key: "revisions", flag: "--revisions", label: "修订次数", hint: "0..10" },
  { key: "max_nodes", flag: "--max-nodes", label: "最多节点数", hint: "1..200" },
] as const;

export type CreateLimitKey = (typeof CREATE_LIMIT_KEYS)[number]["key"];
export type CreateRunLimits = Partial<Record<CreateLimitKey, number>>;

export type CreateRunRequest = {
  question: string;
  workspace?: string;
  limits?: CreateRunLimits;
  diagnostics?: boolean;
};

export type CreateRunResponse = {
  pid: number;
  /** 非空 = 子进程已把 run 写进看板；null = 进程已起但看板还没写进来。 */
  run_id: string | null;
  workspace: string;
  log: string;
  argv: string[];
};

export type ResumeRunResponse = {
  run_id: string;
  pid: number;
  kind: string;
  log: string;
  alive: boolean;
};

export type RunLog = { path: string; text: string };

export type StopRunResponse = {
  ok: boolean;
  status: string;
  terminated?: { ok: boolean; pid: number } | null;
};

/* ------------------------------------------------------- M3 来源与引用（§3.5） */

export type RunProductRef = { path: string; title: string; kind: string };

export type Source = {
  /** sources/xxx.pdf —— 相对 SOURCES.md 所在目录。 */
  placed: string;
  /** downloads/xxx.pdf 或 http(s) URL。 */
  original: string;
  sha256: string | null;
  details: string[];
  /** doc:<id>#p<n> 形式的定位符。 */
  locators: string[];
  /** 从定位符解析出的页码，升序。 */
  pages: number[];
  exists: boolean;
  size: number | null;
};

export type SourceList = {
  path: string;
  node_id: string | null;
  products: RunProductRef[];
  sources: Source[];
};

/** limits 里允许前端改的四个整数（CONTRACT §3.1）。 */
export const EDITABLE_LIMITS = ["sister_parallel", "parallel", "max_followups", "max_revisions"] as const;
export type EditableLimitKey = (typeof EDITABLE_LIMITS)[number];
export type LimitChanges = Partial<Record<EditableLimitKey, number>>;
