import { API_BASE, apiUrl } from "./env";
import type { Session, Snapshot } from "./types";

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
