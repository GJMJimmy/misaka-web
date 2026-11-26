import { API_BASE, apiUrl } from "./env";
import type {
  CreateRunRequest,
  CreateRunResponse,
  LimitChanges,
  NodeDetail,
  ResumeRunResponse,
  RunDetail,
  RunLog,
  RunSummary,
  Session,
  Snapshot,
  SourceList,
  AuditEntry,
  StopRunResponse,
  KeysResponse,
  ModelGlobal,
  ModelSettings,
  ProjectCreated,
  ProjectList,
  Provider,
  ProviderModel,
  RoleDefault,
  SavedKeyResponse,
  SaveModelResponse,
  Sister,
  SisterPatchResponse,
  SisterWriteResponse,
  TerminalProfile,
  TerminalTicket,
} from "./types";

const TOKEN_KEY = "misaka.web.token";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof ApiError) return `${err.message}（${err.code}）`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 503 board_unavailable：环境里没装 MISAKA 或还没有看板。 */
export function isBoardUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.code === "board_unavailable";
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token === null) window.localStorage.removeItem(TOKEN_KEY);
    else window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 隐私模式禁写存储：退化为 cookie 认证 */
  }
}

function authHeader(): Record<string, string> {
  const token = readToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = "http_error";
  let message = `请求失败（HTTP ${res.status}）`;
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
    if (body && typeof body === "object" && body.error) {
      if (typeof body.error.code === "string") code = body.error.code;
      if (typeof body.error.message === "string") message = body.error.message;
    }
  } catch {
    /* 非 JSON 错误体 */
  }
  return new ApiError(res.status, code, message);
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...authHeader(),
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    // credentials: include —— 服务端可能只发 HttpOnly cookie（CONTRACT §2）。
    res = await fetch(apiUrl(path), { ...init, headers, credentials: "include" });
  } catch (err) {
    throw new ApiError(
      0,
      "network_error",
      `无法连接后端 ${API_BASE === "" ? "（同源）" : API_BASE}：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    return undefined as T;
  }
}

const jsonBody = (value: unknown): string => JSON.stringify(value);

/* ------------------------------------------------------------------ M0 会话面 */

/** POST /api/login —— 换 cookie（并保留 token 供 Authorization 头使用）。 */
export async function login(token: string): Promise<void> {
  await requestJson<{ ok: boolean }>("/api/login", {
    method: "POST",
    body: jsonBody({ token }),
  });
}

/** POST /api/logout */
export async function logout(): Promise<void> {
  try {
    await requestJson<{ ok: boolean }>("/api/logout", { method: "POST" });
  } finally {
    writeToken(null);
  }
}

/** GET /api/me */
export async function me(): Promise<{ authenticated: boolean; version?: string }> {
  return requestJson<{ authenticated: boolean; version?: string }>("/api/me");
}

/** GET /api/sessions */
export async function listSessions(): Promise<Session[]> {
  const body = await requestJson<{ sessions?: Session[] }>("/api/sessions");
  return Array.isArray(body?.sessions) ? body.sessions : [];
}

/** GET /api/sessions/{id} —— 进入会话时的那份全量快照。 */
export async function getSession(id: string): Promise<Snapshot> {
  return requestJson<Snapshot>(`/api/sessions/${encodeURIComponent(id)}`);
}

/** POST /api/sessions/{id}/input —— 失败就抛出，绝不自动重发。 */
export async function sendInput(id: string, text: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}/input`, {
    method: "POST",
    body: jsonBody({ text }),
  });
}

/** POST /api/sessions/{id}/pause|resume，返回服务端确认后的 paused。 */
export async function setPaused(id: string, paused: boolean): Promise<boolean> {
  const action = paused ? "pause" : "resume";
  const body = await requestJson<{ ok: boolean; paused?: boolean }>(
    `/api/sessions/${encodeURIComponent(id)}/${action}`,
    { method: "POST" },
  );
  return typeof body?.paused === "boolean" ? body.paused : paused;
}

/** cursor 是 unknown：统一转成可放进 query 的字符串。 */
export function cursorToParam(cursor: unknown): string | null {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor === "string") return cursor === "" ? null : cursor;
  if (typeof cursor === "number") return String(cursor);
  try {
    return JSON.stringify(cursor);
  } catch {
    return null;
  }
}

/** GET /api/sessions/{id}/events?since=<stream_cursor> */
export function eventsUrl(id: string, since: string | null): string {
  const base = apiUrl(`/api/sessions/${encodeURIComponent(id)}/events`);
  return since === null ? base : `${base}?since=${encodeURIComponent(since)}`;
}

/* ------------------------------------------------------------------ M1 研究面 */

/** GET /api/runs —— 503 board_unavailable 会抛 ApiError(code="board_unavailable")。 */
export async function listRuns(): Promise<RunSummary[]> {
  const body = await requestJson<{ runs?: RunSummary[] }>("/api/runs");
  return Array.isArray(body?.runs) ? body.runs : [];
}

/** GET /api/runs/{run_id} */
export async function getRun(runId: string): Promise<RunDetail> {
  return requestJson<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`);
}

/** GET /api/runs/{run_id}/nodes/{node_id} */
export async function getRunNode(runId: string, nodeId: string): Promise<NodeDetail> {
  return requestJson<NodeDetail>(
    `/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`,
  );
}

/* ------------------------------------------------------- M3 来源与引用（§3.5） */

/** GET /api/runs/{run_id}/sources?node=… —— 没有清单时服务端 404。 */
export async function getRunSources(runId: string, nodeId?: string | null): Promise<SourceList> {
  const base = `/api/runs/${encodeURIComponent(runId)}/sources`;
  return requestJson<SourceList>(nodeId ? `${base}?node=${encodeURIComponent(nodeId)}` : base);
}

/**
 * GET /api/runs/{run_id}/file?path=<rel>&node=<node_id> 的绝对 URL。
 * 页面内 <embed> 与新标签打开都用它：path 相对节点目录（带 node）或运行 workspace。
 */
export function runFileUrl(runId: string, path: string, nodeId?: string | null): string {
  const query = `path=${encodeURIComponent(path)}${nodeId ? `&node=${encodeURIComponent(nodeId)}` : ""}`;
  return apiUrl(`/api/runs/${encodeURIComponent(runId)}/file?${query}`);
}

/** 同一端点的文本读取（markdown / txt / SOURCES.md）。404 = 这个路径不在产物里。 */
export async function fetchRunFileText(
  runId: string,
  path: string,
  nodeId?: string | null,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(runFileUrl(runId, path, nodeId), {
      headers: { Accept: "text/plain, text/markdown, */*", ...authHeader() },
      credentials: "include",
    });
  } catch (err) {
    throw new ApiError(
      0,
      "network_error",
      `无法连接后端：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw await toApiError(res);
  return res.text();
}

/** POST /api/runs/{run_id}/tell —— 审批就是对话：发一句话给节点的 Last Order。 */
export async function tellRun(
  runId: string,
  text: string,
  nodeId?: string,
): Promise<{ ok: boolean; node_id: string; session_id: string }> {
  return requestJson<{ ok: boolean; node_id: string; session_id: string }>(
    `/api/runs/${encodeURIComponent(runId)}/tell`,
    { method: "POST", body: jsonBody(nodeId ? { text, node_id: nodeId } : { text }) },
  );
}

/** POST /api/runs/{run_id}/stop —— force=true 且由本桥接托管时再终止进程。 */
export async function stopRun(runId: string, force = false): Promise<StopRunResponse> {
  return requestJson<StopRunResponse>(`/api/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    ...(force ? { body: jsonBody({ force: true }) } : {}),
  });
}

/** POST /api/runs/{run_id}/limits —— 只允许四个整数键，回读 after。 */
export async function changeRunLimits(
  runId: string,
  changes: LimitChanges,
): Promise<{ ok: boolean; before: Record<string, unknown>; after: Record<string, unknown> }> {
  return requestJson<{ ok: boolean; before: Record<string, unknown>; after: Record<string, unknown> }>(
    `/api/runs/${encodeURIComponent(runId)}/limits`,
    { method: "POST", body: jsonBody({ changes }) },
  );
}

/* ------------------------------------------------------- M2 进程托管（§3.4） */

/** POST /api/runs —— 启动一个研究子进程；run_id 可能为 null（看板还没写进来）。 */
export async function createRun(body: CreateRunRequest): Promise<CreateRunResponse> {
  return requestJson<CreateRunResponse>("/api/runs", { method: "POST", body: jsonBody(body) });
}

/** POST /api/runs/{run_id}/resume */
export async function resumeRun(runId: string): Promise<ResumeRunResponse> {
  return requestJson<ResumeRunResponse>(`/api/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
}

/** GET /api/runs/{run_id}/log?lines=… —— 非本桥接启动的 run → 404。 */
export async function getRunLog(runId: string, lines = 300): Promise<RunLog> {
  return requestJson<RunLog>(`/api/runs/${encodeURIComponent(runId)}/log?lines=${lines}`);
}

/* ------------------------------------------------------- M4 审计 */

const AUDIT_KNOWN = new Set([
  "at",
  "ts",
  "time",
  "timestamp",
  "action",
  "event",
  "kind",
  "run_id",
  "runId",
  "node_id",
  "nodeId",
  "pid",
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  }
  return null;
}

/** audit.jsonl 的行形状没有写在契约里，这里容忍 at/ts/time、run_id/runId 等变体。 */
function normalizeAuditEntry(raw: unknown): AuditEntry | null {
  if (!isPlainRecord(raw)) return null;
  const action = firstString(raw, ["action", "event", "kind"]);
  if (!action) return null;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!AUDIT_KNOWN.has(key)) extra[key] = value;
  }
  return {
    at: firstString(raw, ["at", "ts", "time", "timestamp"]),
    action,
    run_id: firstString(raw, ["run_id", "runId"]),
    node_id: firstString(raw, ["node_id", "nodeId"]),
    pid: firstNumber(raw, ["pid"]),
    extra,
  };
}

/** GET /api/audit?limit=200&action= —— 响应形状防御式解析（数组 / entries / events / audit / items 都认）。 */
export async function getAudit(limit = 200, action?: string | null): Promise<AuditEntry[]> {
  const query = `limit=${encodeURIComponent(String(limit))}${action ? `&action=${encodeURIComponent(action)}` : ""}`;
  const body = await requestJson<unknown>(`/api/audit?${query}`);

  const candidates: unknown[] = [
    body,
    isPlainRecord(body) ? body.entries : null,
    isPlainRecord(body) ? body.events : null,
    isPlainRecord(body) ? body.audit : null,
    isPlainRecord(body) ? body.items : null,
    isPlainRecord(body) ? body.lines : null,
  ];
  const list = candidates.find((item) => Array.isArray(item)) as unknown[] | undefined;
  if (!list) return [];

  const entries: AuditEntry[] = [];
  for (const item of list) {
    const entry = normalizeAuditEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * 仅 VITE_MOCK=1 使用：切换研究面的演示状态（列表空态/503、进程 alive/dead/null、
 * 新建时 run_id 是否为 null、审计空态）。真实后端没有这个端点，MOCK=false 的构建里永远不会调用。
 */
export async function setMockResearchMode(patch: {
  mode?: "normal" | "empty" | "board_unavailable";
  process?: "default" | "alive" | "dead" | "null";
  createRunIdNull?: boolean;
  audit?: "normal" | "empty";
}): Promise<void> {
  await requestJson<{ ok: boolean }>("/api/__mock/research", {
    method: "POST",
    body: jsonBody(patch),
  });
}

/* ------------------------------------------------------- M5 配置台（§3.7） */

/** GET /api/settings/model —— 防御式解析：global / roles / providers 缺一个都不该整页白。 */
export async function getModelSettings(): Promise<ModelSettings> {
  const body = await requestJson<unknown>("/api/settings/model");
  const record = isPlainRecord(body) ? body : {};
  return {
    global: isPlainRecord(record.global) ? (record.global as ModelGlobal) : {},
    roles: Array.isArray(record.roles) ? (record.roles as RoleDefault[]) : [],
    providers: Array.isArray(record.providers) ? (record.providers as Provider[]) : [],
  };
}

/**
 * GET /api/settings/models?provider= —— **按需**取一个 provider 的模型目录。
 *
 * 只服务「用户选中了某个 provider」这一件事：进入设置页绝不为所有 provider 预取
 * （那样一次会打出几十个请求）。按 provider id 缓存，同一 provider 的并发调用只发一次；
 * 失败不缓存，重试就能重新发。
 */
const MODEL_CACHE = new Map<string, ProviderModel[]>();
const MODEL_IN_FLIGHT = new Map<string, Promise<ProviderModel[]>>();

export async function getProviderModels(provider: string): Promise<ProviderModel[]> {
  const cached = MODEL_CACHE.get(provider);
  if (cached) return cached;
  const pending = MODEL_IN_FLIGHT.get(provider);
  if (pending) return pending;

  const task = requestJson<{ models?: ProviderModel[] }>(
    `/api/settings/models?provider=${encodeURIComponent(provider)}`,
  )
    .then((body) => {
      const models = Array.isArray(body?.models) ? body.models : [];
      MODEL_CACHE.set(provider, models);
      return models;
    })
    .finally(() => {
      MODEL_IN_FLIGHT.delete(provider);
    });
  MODEL_IN_FLIGHT.set(provider, task);
  return task;
}

/** 换了密钥就可能多出/少掉模型：密钥写入或删除后让目录缓存失效。 */
function forgetModelCatalog(): void {
  MODEL_CACHE.clear();
  MODEL_IN_FLIGHT.clear();
}

/** PUT /api/settings/model —— role 省略=写全局；role 给空 provider/model=mock 侧的「跟随全局」。 */
export async function saveModelSettings(body: {
  provider: string;
  model: string;
  role?: string;
}): Promise<SaveModelResponse> {
  return requestJson<SaveModelResponse>("/api/settings/model", {
    method: "PUT",
    body: jsonBody(body),
  });
}

/** GET /api/settings/keys —— 只有 hint，永远没有明文。 */
export async function getSettingsKeys(): Promise<KeysResponse> {
  const body = await requestJson<{ path?: string; keys?: unknown }>("/api/settings/keys");
  return {
    path: typeof body?.path === "string" ? body.path : "",
    keys: Array.isArray(body?.keys) ? (body.keys as KeysResponse["keys"]) : [],
  };
}

/** PUT /api/settings/keys/{name} —— value 只进请求体，从不回到 DOM。 */
export async function putSettingsKey(name: string, value: string): Promise<SavedKeyResponse> {
  const result = await requestJson<SavedKeyResponse>(`/api/settings/keys/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: jsonBody({ value }),
  });
  forgetModelCatalog();
  return result;
}

/** DELETE /api/settings/keys/{name} */
export async function deleteSettingsKey(name: string): Promise<{ ok: boolean; name: string }> {
  const result = await requestJson<{ ok: boolean; name: string }>(
    `/api/settings/keys/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  forgetModelCatalog();
  return result;
}

/** GET /api/sisters */
export async function listSisters(): Promise<Sister[]> {
  const body = await requestJson<{ sisters?: unknown }>("/api/sisters");
  return Array.isArray(body?.sisters) ? (body.sisters as Sister[]) : [];
}

/** POST /api/sisters */
export async function createSister(body: {
  id: string;
  specialty?: string;
  model?: string;
  thinking?: string;
}): Promise<SisterWriteResponse> {
  return requestJson<SisterWriteResponse>("/api/sisters", { method: "POST", body: jsonBody(body) });
}

/** PATCH /api/sisters/{id} —— model:"" 表示取消钉死、回到全局默认。 */
export async function patchSister(
  id: string,
  body: { specialty?: string; model?: string; thinking?: string },
): Promise<SisterPatchResponse> {
  return requestJson<SisterPatchResponse>(`/api/sisters/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: jsonBody(body),
  });
}

/** DELETE /api/sisters/{id} —— 服务端要求显式 confirm，否则 422 confirmation_required。 */
export async function deleteSister(id: string): Promise<SisterWriteResponse> {
  return requestJson<SisterWriteResponse>(`/api/sisters/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: jsonBody({ confirm: true }),
  });
}

/** GET /api/projects */
export async function listProjects(): Promise<ProjectList> {
  const body = await requestJson<{ root?: string; projects?: unknown }>("/api/projects");
  return {
    root: typeof body?.root === "string" ? body.root : "",
    projects: Array.isArray(body?.projects) ? (body.projects as ProjectList["projects"]) : [],
  };
}

/** POST /api/projects */
export async function createProject(body: { name: string; git?: boolean }): Promise<ProjectCreated> {
  return requestJson<ProjectCreated>("/api/projects", { method: "POST", body: jsonBody(body) });
}

/* ------------------------------------------------------- M7 终端（§3.8） */

/**
 * POST /api/terminal/ticket —— 一次性票据（30 秒），WebSocket 只认它，不认 long-lived token。
 * scene 只出现在 VITE_MOCK=1 的演示路径里：让本地 mock 后端给出指定的错误码。
 */
export async function createTerminalTicket(body: {
  profile: TerminalProfile;
  cwd?: string;
  arg?: string;
  scene?: string;
}): Promise<TerminalTicket> {
  const payload: Record<string, unknown> = { profile: body.profile };
  if (body.cwd) payload.cwd = body.cwd;
  if (body.arg) payload.arg = body.arg;
  if (body.scene) payload.scene = body.scene;
  return requestJson<TerminalTicket>("/api/terminal/ticket", {
    method: "POST",
    body: jsonBody(payload),
  });
}
