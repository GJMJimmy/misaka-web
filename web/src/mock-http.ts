/** mock 后端共用的 HTTP 小工具（mock.ts 与 mock-research.ts 都用）。 */

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function parseBody<T>(bodyText: string | null): T | null {
  if (!bodyText) return null;
  try {
    return JSON.parse(bodyText) as T;
  } catch {
    return null;
  }
}
