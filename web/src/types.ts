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
  run_id?: string | null;
  node_id?: string | null;
  last_activity?: string | null;
};

/** 上游会话条目，原样透传（content 形状未知，渲染层做防御式处理）。 */
// A session entry, not a bare message: {type, message|summary|data, timestamp}. Older mocks
// (and the streaming frame) hand us message shapes directly, so both are allowed.
export type Entry = {
  type?: string;
  role?: string;
  content?: unknown;
  message?: unknown;
  timestamp?: string;
  [key: string]: unknown;
};

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
  /** 属主进程已退出：历史来自 transcript，只读。 */
  read_only?: boolean;
  /** 这个会话属于哪个 research run（服务端从看板查），来源面板需要它。 */
  run_id?: string | null;
  node_id?: string | null;
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

/* ------------------------------------------------------- M4 审计（运维） */

/** GET /api/audit 的一行（audit.jsonl 语义：{at, action, run_id, …}，已做防御式归一化）。 */
export type AuditEntry = {
  at: string | number | null;
  action: string;
  run_id: string | null;
  node_id: string | null;
  pid: number | null;
  /** 其余字段原样保留，界面上折叠展示。 */
  extra: Record<string, unknown>;
};

/** limits 里允许前端改的四个整数（CONTRACT §3.1）。 */
export const EDITABLE_LIMITS = ["sister_parallel", "parallel", "max_followups", "max_revisions"] as const;
export type EditableLimitKey = (typeof EDITABLE_LIMITS)[number];
export type LimitChanges = Partial<Record<EditableLimitKey, number>>;

/* ------------------------------------------------------- M5 配置台（§3.7） */

export type ProviderModel = { id: string; name: string };

/** §3.7 的 Provider。契约写的是 providers[].models，真实服务端只给 model_count，
    所以 models 可选：缺失时用 GET /api/settings/models?provider= 补。 */
export type Provider = {
  id: string;
  name: string;
  configured: boolean;
  source?: string | null;
  keyless: boolean;
  models?: ProviderModel[];
  model_count?: number;
};

export type ModelGlobal = {
  provider?: string | null;
  model?: string | null;
  thinking?: string | null;
};

/** role = "last-order" | "sister:<id>"；settings 里是 defaultProvider / defaultModel。 */
export type RoleDefault = { role: string; settings: Record<string, unknown> };

export type ModelSettings = {
  global: ModelGlobal;
  roles: RoleDefault[];
  providers: Provider[];
};

export type SaveModelResponse = { ok: boolean; role: string; provider: string; model: string };

export type KeyEntry = {
  name: string;
  label: string;
  configured: boolean;
  source?: string | null;
  hint: string;
};

export type KeysResponse = { path: string; keys: KeyEntry[] };

export type SavedKeyResponse = { ok: boolean; name: string; hint: string };

export type Sister = { id: string; specialty: string; model: string; thinking: string };

export type SisterWriteResponse = { ok: boolean; id: string; message: string };
export type SisterPatchResponse = { ok: boolean; id: string; changed: string[] };

export type ProjectEntry = {
  name: string;
  path: string;
  has_project_md: boolean;
  is_git: boolean;
  has_sources: boolean;
  runs: number;
};

export type ProjectList = { root: string; projects: ProjectEntry[] };

export type ProjectCreated = { ok: boolean; name: string; path: string; actions: string[] };
/* ------------------------------------------------------- M7 终端（§3.8） */

export type TerminalProfile = "shell" | "misaka" | "panel" | "attach";

/** POST /api/terminal/ticket 的响应。mode 只在 Windows 退化成管道模式时出现。 */
export type TerminalTicket = {
  ticket: string;
  ws_url: string;
  expires_in: number;
  profile: TerminalProfile;
  cwd: string;
  cols: number;
  rows: number;
  mode?: "pty" | "pipe";
};

/** 客户端 → 服务端（JSON 文本帧）。 */
export type TerminalFrameIn =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" };

/** 服务端 → 客户端（JSON 文本帧）。output 原样喂给 xterm.write()。 */
export type TerminalFrameOut =
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null; signal?: string | null }
  | { type: "error"; code: string; message: string }
  | { type: "pong" };
