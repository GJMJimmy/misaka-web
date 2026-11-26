import { ApiError, describeError, isBoardUnavailable, isUnauthorized } from "./api";

export type LoadFailureKind =
  | "unauthorized"
  | "board_unavailable"
  | "not_found"
  | "invalid_request"
  | "other";

export type LoadFailure = { kind: LoadFailureKind; message: string; raw: string };

/** 把读请求的异常归类：503 board_unavailable / 401 / 404 / 422 各有各的界面。 */
export function classifyError(err: unknown, what: string): LoadFailure {
  const raw = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
  if (isBoardUnavailable(err)) return { kind: "board_unavailable", message: describeError(err), raw };
  if (isUnauthorized(err)) return { kind: "unauthorized", message: "登录已失效，请重新登录。", raw };
  if (err instanceof ApiError && err.status === 404) {
    return { kind: "not_found", message: `${what}不存在或已被清理：${raw}`, raw };
  }
  if (err instanceof ApiError && err.status === 422) return { kind: "invalid_request", message: raw, raw };
  return { kind: "other", message: `${what}失败：${describeError(err)}`, raw };
}
