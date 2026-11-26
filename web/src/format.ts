function relativeFromMs(ms: number): string {
  const diff = Date.now() - ms;
  if (diff >= 0 && diff < 60_000) return "刚刚";
  if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff >= 0 && diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 0) return new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return new Date(ms).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(iso?: string | null): string {
  if (!iso) return "";
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  return relativeFromMs(time);
}

/** 服务端时间戳是 number，秒/毫秒都可能：小于 1e12 视为秒。 */
export function toMillis(value?: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
}

export function formatRelativeMs(value?: number | null): string {
  const ms = toMillis(value);
  return ms === null ? "" : relativeFromMs(ms);
}

export function formatBytes(size?: number | null): string {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function formatClock(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 状态 → 语义色，供 .chip--tone-* 使用。 */
export function statusTone(status?: string | null): "ok" | "run" | "warn" | "err" | "muted" {
  const value = (status ?? "").toLowerCase();
  if (value === "" || value === "pending" || value === "queued" || value === "idle") return "muted";
  if (value === "done" || value === "completed" || value === "success" || value === "merged") return "ok";
  if (value === "running" || value === "working" || value === "active" || value === "in_progress") return "run";
  if (value === "awaiting_approval" || value === "blocked" || value === "waiting" || value === "stopping") return "warn";
  if (value === "failed" || value === "error" || value === "canceled" || value === "cancelled") return "err";
  return "muted";
}
