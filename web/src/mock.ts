import { handleCommands } from "./mock-commands";
import { delay, errorResponse, jsonResponse } from "./mock-http";
import { handleResearch } from "./mock-research";
import { handleSettings } from "./mock-settings";
import type { Delta, Entry, Session, SessionRunState, Snapshot } from "./types";

/**
 * VITE_MOCK=1 的本地后端：替换 window.fetch 与 window.EventSource。
 *
 * 目的：没有 Python 服务时也能 `vite build`、演示与回归 UI —— 演示路径与真实后端
 * 完全一致（同样的端点、同样的 SSE snapshot/delta/error 语义），所以 UI 只走一套代码。
 *
 * 演示指令（直接发到输入框；单斜杠留给 §3.8 的桥接命令，所以这里用双斜杠）：
 *   //fail     -> 502 投递未确认（演示「显式报错、不自动重发」）
 *   //offline  -> 模拟 SSE 传输层断开（演示顶部 banner + 手动重连）
 *   //error    -> 服务端 `event: error`（演示会话失效后停止、不自动重连）
 *   登录 token 输入 `reject` -> 401
 */

type Store = {
  id: string;
  title: string;
  role: string;
  cwd: string;
  catalogState: "live" | "saved";
  hasControl: boolean;
  runState: SessionRunState;
  paused: boolean;
  error: string | null;
  entries: Entry[];
  streaming: Entry | null;
  cursor: number;
  streamCursor: number;
  lastActivity: string;
  /** CONTRACT §3.9：工作目录已不在磁盘上。 */
  workspaceMissing: boolean;
  /** CONTRACT §3.9：只从本服务的列表里隐藏（会话本身还在）。 */
  hidden: boolean;
};

const STORE = new Map<string, Store>();
const SUBSCRIBERS = new Map<string, Set<MockEventSource>>();
let sessionCookieAuthed = false;

const nowIso = (): string => new Date().toISOString();

function sseResponse(): Response {
  return new Response(null, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}

/* ------------------------------------------------------------------ 种子数据 */

function makeStore(partial: Partial<Store> & { id: string; title: string }): Store {
  const store: Store = {
    role: "primary",
    cwd: "~/projects/misaka",
    catalogState: "live",
    hasControl: true,
    runState: "idle",
    paused: false,
    error: null,
    entries: [],
    streaming: null,
    cursor: 0,
    streamCursor: 0,
    lastActivity: nowIso(),
    workspaceMissing: false,
    hidden: false,
    ...partial,
  };
  STORE.set(store.id, store);
  return store;
}

const t0 = Date.now();
const at = (minutesAgo: number): string => new Date(t0 - minutesAgo * 60_000).toISOString();

function seed(): void {
  if (STORE.size > 0) return;

  makeStore({
    id: "s-demo",
    title: "重构 misaka-web 前端",
    entries: [
      {
        role: "user",
        content: "先做会话视图：全量快照 + SSE 增量，别引入路由库和组件库。",
        ts: at(58),
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              "收到。路径是：GET /api/sessions/{id} 拿全量快照，再用 EventSource 订阅 /api/sessions/{id}/events，\n" +
              "snapshot 全量替换、delta 只追加、streaming 原位更新，保证已渲染内容不重排。",
          },
          { type: "tool_use", name: "read_file", input: { path: "CONTRACT.md" } },
        ],
        ts: at(57),
      },
      {
        role: "tool",
        content: { tool: "read_file", path: "CONTRACT.md", result: "103 lines (frozen)" },
        ts: at(56),
      },
      {
        role: "assistant",
        content: "断线一律停止并显式提示：不自动重连，只在用户点重连时用 since=stream_cursor 续订。",
        ts: at(40),
      },
    ],
    lastActivity: at(40),
    streamCursor: 12,
    cursor: 4,
  });

  makeStore({
    id: "s-secondary",
    title: "deploy：systemd + Caddy",
    role: "secondary",
    cwd: "~/projects/misaka-web",
    catalogState: "saved",
    hasControl: false,
    // 演示 §3.9：这个会话的工作目录已经不在磁盘上，卡片照样打开，但要能看出来。
    workspaceMissing: true,
    entries: [
      { role: "user", content: "把静态站挂到 Caddy 上，反代 /api 到 127.0.0.1:8787。", ts: at(180) },
      { role: "assistant", content: "已写好 deploy/Caddyfile 草案，等你 review。", ts: at(178) },
    ],
    lastActivity: at(178),
    streamCursor: 3,
    cursor: 2,
  });

  makeStore({
    // 演示 §3.9：默认列表看不见它；打开「显示已隐藏」才会以弱化样式出现，可恢复。
    id: "s-orphan",
    title: "旧项目：atlas 抓取器",
    role: "secondary",
    cwd: "~/projects/atlas-old",
    catalogState: "saved",
    hasControl: false,
    workspaceMissing: true,
    hidden: true,
    entries: [{ role: "user", content: "（这个项目的文件夹已经被删掉了。）", ts: at(2880) }],
    lastActivity: at(2880),
    streamCursor: 1,
    cursor: 1,
  });
}

/* ------------------------------------------------------------------ 快照与事件 */

function snapshotOf(store: Store): Snapshot {
  return {
    id: store.id,
    cwd: store.cwd,
    state: store.runState,
    paused: store.paused,
    error: store.error,
    workflow: null,
    streaming: store.streaming,
    // 服务端语义：snapshot.entries 是全量
    entries: store.entries.slice(),
    cursor: store.cursor,
    stream_cursor: store.streamCursor,
  };
}

function toSession(store: Store): Session {
  return {
    id: store.id,
    role: store.role,
    cwd: store.cwd,
    state: store.catalogState,
    title: store.title,
    has_control: store.hasControl,
    last_activity: store.lastActivity,
    workspace_missing: store.workspaceMissing,
    hidden: store.hidden,
  };
}

function emitDelta(store: Store, delta: Delta): void {
  store.cursor += 1;
  store.streamCursor += 1;
  const payload: Delta = { ...delta, cursor: store.cursor, stream_cursor: store.streamCursor };
  const subscribers = SUBSCRIBERS.get(store.id);
  if (!subscribers) return;
  for (const sub of subscribers) sub.emit("delta", payload);
}

/* ------------------------------------------------------------------ 流式脚本 */

const CANNED: Array<{ match: RegExp; reply: string }> = [
  {
    match: /测试|test/i,
    reply:
      "已收到。这条回复由 VITE_MOCK=1 的本地 mock 逐块推送，用来验证增量追加不会重排已渲染的内容：\n" +
      "每块只改 streaming 这一段，历史条目一个字节都不动。",
  },
  {
    match: /暂停|pause/i,
    reply: "暂停走 POST /api/sessions/{id}/pause，恢复走 .../resume；按钮状态以服务端返回的 paused 为准。",
  },
  {
    match: /部署|deploy/i,
    reply:
      "前端产物 web/dist 同步到 src/misaka_web/static/，由 FastAPI 直接托管；服务器不装 node，" +
      "所以构建只发生在开发机。",
  },
];

function pickReply(text: string): string {
  for (const item of CANNED) if (item.match.test(text)) return item.reply;
  return (
    `（mock）收到「${text.slice(0, 60)}」。\n\n` +
    "这是本地模拟的助手回复，按 1~3 个字符一块推送到 streaming 字段；真实后端由控制 socket 提供同样的增量。"
  );
}

function chunk(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = 1 + ((i * 7) % 3);
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

function startReply(store: Store, userText: string): void {
  const reply = pickReply(userText);
  const live: Entry = { role: "assistant", content: "", ts: nowIso() };
  store.streaming = live;
  store.runState = "working";
  emitDelta(store, { state: "working", streaming: { ...live } });

  const chunks = chunk(reply);
  let index = 0;

  const finish = (): void => {
    const finished: Entry = { role: "assistant", content: reply, ts: live.ts };
    store.entries.push(finished);
    store.streaming = null;
    store.runState = "idle";
    store.lastActivity = nowIso();
    emitDelta(store, { state: "idle", streaming: null, entries: [finished] });
  };

  const step = (): void => {
    if (!STORE.has(store.id) || store.streaming !== live) return;
    if (store.paused) {
      window.setTimeout(step, 400);
      return;
    }
    if (index >= chunks.length) {
      finish();
      return;
    }
    live.content = String(live.content) + chunks[index];
    index += 1;
    emitDelta(store, { streaming: { ...live } });
    window.setTimeout(step, 30);
  };

  window.setTimeout(step, 120);
}

function acceptInput(store: Store, text: string): void {
  // 输入框把单个 / 交给桥接层，所以演示指令改用双斜杠；这里去掉一个斜杠再匹配。
  const directive = text.startsWith("//") ? text.slice(1) : text;
  if (directive === "/fail") return;
  if (directive === "/offline" || directive === "/error") {
    const note: Entry = {
      role: "system",
      content:
        directive === "/offline"
          ? "（mock）已模拟 SSE 传输层断开：顶部出现断线 banner，点「重连」用 since=stream_cursor 续订。"
          : "（mock）已模拟服务端 event: error：客户端停止接收且不自动重连，点「重试」重新订阅。",
      ts: nowIso(),
    };
    store.entries.push(note);
    store.lastActivity = nowIso();
    emitDelta(store, { entries: [note] });
    window.setTimeout(() => {
      const subscribers = Array.from(SUBSCRIBERS.get(store.id) ?? []);
      for (const sub of subscribers) {
        if (directive === "/offline") {
          SUBSCRIBERS.get(store.id)?.delete(sub);
          sub.emitTransportError();
        } else {
          sub.emit("error", { code: "session_gone", message: "（mock）属主会话已失效，客户端不自动重连。" });
        }
      }
    }, 260);
    return;
  }

  const entry: Entry = { role: "user", content: text, ts: nowIso() };
  store.entries.push(entry);
  store.lastActivity = nowIso();
  emitDelta(store, { state: "working", entries: [entry] });
  startReply(store, text);
}

/* ------------------------------------------------------------------ 假 EventSource */

type Listener = (ev: Event) => void;

function messageEvent(type: string, payload: unknown): Event {
  return new MessageEvent(type, { data: JSON.stringify(payload) });
}

class MockEventSource {
  readonly url: string;
  readyState = 0;
  withCredentials = true;
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly sessionId: string | null;
  private closedByClient = false;

  constructor(url: string) {
    this.url = url;
    const parsed = new URL(url, window.location.origin);
    const match = /\/api\/sessions\/([^/]+)\/events$/.exec(parsed.pathname);
    this.sessionId = match ? decodeURIComponent(match[1]) : null;
    window.setTimeout(() => this.open(), 0);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = 2;
    if (this.sessionId) SUBSCRIBERS.get(this.sessionId)?.delete(this);
  }

  emit(type: string, payload: unknown): void {
    if (this.closedByClient) return;
    this.dispatch(type, messageEvent(type, payload));
  }

  /** 模拟传输层断开：不带 data 的 error 事件（与真实 EventSource 一致）。 */
  emitTransportError(): void {
    if (this.closedByClient) return;
    this.dispatch("error", new Event("error"));
  }

  private dispatch(type: string, ev: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(ev);
    const prop =
      type === "open" ? this.onopen : type === "error" ? this.onerror : type === "message" ? this.onmessage : null;
    if (prop) prop(ev);
  }

  private open(): void {
    if (this.closedByClient) return;
    const store = this.sessionId ? STORE.get(this.sessionId) : undefined;
    if (!store) {
      this.emit("error", { code: "session_not_found", message: "（mock）会话不存在。" });
      this.close();
      return;
    }
    this.readyState = 1;
    this.dispatch("open", new Event("open"));
    // 连接建立后立刻发一次全量快照（CONTRACT §3）
    this.emit("snapshot", snapshotOf(store));
    const set = SUBSCRIBERS.get(store.id) ?? new Set<MockEventSource>();
    set.add(this);
    SUBSCRIBERS.set(store.id, set);
  }
}

/* ------------------------------------------------------------------ 假 fetch */

function hasStoredToken(): boolean {
  try {
    return (window.localStorage.getItem("misaka.web.token") ?? "") !== "";
  } catch {
    return false;
  }
}

const isAuthed = (): boolean => sessionCookieAuthed || hasStoredToken();

/** §3.9 的 include_hidden 查询参数：1 / true / yes 都算打开。 */
const flag = (raw: string | null): boolean => raw === "1" || raw === "true" || raw === "yes";

async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl, window.location.origin);
  const method = (init?.method ?? "GET").toUpperCase();
  const bodyText = typeof init?.body === "string" ? init.body : null;
  const apiIndex = url.pathname.indexOf("/api/");
  if (apiIndex < 0) throw new Error(`mock: 未处理的请求 ${rawUrl}`);
  const path = url.pathname.slice(apiIndex);

  await delay(70);

  if (path === "/api/health" && method === "GET") {
    return jsonResponse({ ok: true, version: "mock", misaka_version: "mock", board_schema: 0, uptime_s: 1 });
  }

  if (path === "/api/login" && method === "POST") {
    let token = "";
    try {
      const parsed = bodyText ? (JSON.parse(bodyText) as { token?: unknown }) : {};
      token = typeof parsed.token === "string" ? parsed.token.trim() : "";
    } catch {
      return errorResponse(400, "bad_request", "请求体不是合法 JSON。");
    }
    if (token === "") return errorResponse(400, "bad_request", "token 不能为空。");
    if (token.toLowerCase() === "reject") {
      return errorResponse(401, "unauthorized", "（mock）该 token 被拒绝，换任意其他非空值即可。");
    }
    sessionCookieAuthed = true;
    return jsonResponse({ ok: true });
  }

  if (path === "/api/logout" && method === "POST") {
    sessionCookieAuthed = false;
    return jsonResponse({ ok: true });
  }

  if (!isAuthed()) {
    return errorResponse(401, "unauthorized", "（mock）未认证，请用任意非空 token 登录。");
  }

  // M6 斜杠命令（§3.8）交给 mock-commands.ts
  if (path === "/api/commands" || path === "/api/command") {
    const handled = await handleCommands(path, method, bodyText);
    if (handled) return handled;
  }

  // M1 研究面（/api/runs*）与 mock 演示开关（/api/__mock/*）交给 mock-research.ts
  if (path.startsWith("/api/runs") || path === "/api/audit" || path.startsWith("/api/__mock/")) {
    const handled = await handleResearch(path, method, bodyText, url.searchParams);
    if (handled) return handled;
  }

  // M5 配置台（§3.7）交给 mock-settings.ts
  if (path.startsWith("/api/settings/") || path.startsWith("/api/sisters") || path === "/api/projects") {
    const handled = await handleSettings(path, method, bodyText, url.searchParams);
    if (handled) return handled;
  }

  if (path === "/api/me" && method === "GET") {
    return jsonResponse({ authenticated: true, version: "mock" });
  }

  if (path === "/api/sessions" && method === "GET") {
    seed();
    const includeHidden = flag(url.searchParams.get("include_hidden"));
    const rows = Array.from(STORE.values()).filter((store) => includeHidden || !store.hidden);
    return jsonResponse({ sessions: rows.map(toSession) });
  }

  const eventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(path);
  if (eventsMatch && method === "GET") {
    // 真实后端在这里返回 text/event-stream；EventSource 已被替换成 MockEventSource。
    return sseResponse();
  }

  const match = /^\/api\/sessions\/([^/]+)(?:\/(input|pause|resume|hide))?$/.exec(path);
  if (!match) return errorResponse(404, "not_found", `（mock）未实现 ${method} ${path}`);

  seed();
  const store = STORE.get(decodeURIComponent(match[1]));
  if (!store) return errorResponse(404, "session_not_found", "（mock）会话不存在。");

  if (match[2] === undefined && method === "GET") return jsonResponse(snapshotOf(store));

  // §3.9：只动列表，会话本身原样留着；POST 隐藏、DELETE 恢复。
  if (match[2] === "hide" && (method === "POST" || method === "DELETE")) {
    store.hidden = method === "POST";
    return jsonResponse({ ok: true, id: store.id, hidden: store.hidden });
  }

  if (match[2] === "input" && method === "POST") {
    let text = "";
    try {
      const parsed = bodyText ? (JSON.parse(bodyText) as { text?: unknown }) : {};
      text = typeof parsed.text === "string" ? parsed.text : "";
    } catch {
      return errorResponse(400, "bad_request", "请求体不是合法 JSON。");
    }
    if (!store.hasControl) {
      return errorResponse(403, "no_control", "（mock）本会话无控制权，只能只读观察。");
    }
    if (text.trim() === "") return errorResponse(400, "bad_request", "text 不能为空。");
    if (text === "/fail") {
      return errorResponse(
        502,
        "input_not_delivered",
        "控制 socket 未在超时内返回 ack，投递未确认（mock）。",
      );
    }
    acceptInput(store, text);
    return jsonResponse({ ok: true });
  }

  if (match[2] === "pause" && method === "POST") {
    store.paused = true;
    emitDelta(store, { state: store.runState });
    return jsonResponse({ ok: true, paused: true });
  }

  if (match[2] === "resume" && method === "POST") {
    store.paused = false;
    emitDelta(store, { state: store.runState });
    return jsonResponse({ ok: true, paused: false });
  }

  return errorResponse(404, "not_found", `（mock）未实现 ${method} ${path}`);
}

/* ------------------------------------------------------------------ 安装 */

export function installMockBackend(): void {
  const target = window as unknown as { fetch: typeof fetch; EventSource: unknown };
  target.fetch = mockFetch as unknown as typeof fetch;
  target.EventSource = MockEventSource;
  // eslint-disable-next-line no-console
  console.info(
    "[misaka-web] VITE_MOCK=1：已启用本地 mock 后端（fetch + EventSource），无需 Python 服务。",
  );
}
