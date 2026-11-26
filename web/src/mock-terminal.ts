import { errorResponse, jsonResponse } from "./mock-http";
import type { TerminalFrameOut, TerminalProfile } from "./types";

/**
 * VITE_MOCK=1：终端（§3.8）的本地假后端。
 *
 * 票据端点照真实状态码走；WebSocket 用本地假帧模拟（不连真 PTY），并且能按 ticket 请求里的
 * `scene` 复现每一个错误码，让 mock 模式下页面可演示：
 *   too_many_terminals / pty_unavailable / bad_profile  -> 取票阶段失败
 *   ticket_expired / terminal_disabled                  -> 连上之后来一帧 error
 *   drop                                                -> 无声断开（测试「断线不静默」）
 *   exit1                                               -> exit 帧退出码 1
 */

const PROFILES: TerminalProfile[] = ["shell", "misaka", "panel", "attach"];
const SCENES = [
  "normal",
  "too_many_terminals",
  "pty_unavailable",
  "bad_profile",
  "ticket_expired",
  "terminal_disabled",
  "drop",
  "exit1",
] as const;
type Scene = (typeof SCENES)[number];

const WORKSPACE_ROOT = "/srv/misaka/workspace";

type TicketState = { profile: TerminalProfile; cwd: string; scene: Scene };

const TICKETS = new Map<string, TicketState>();
let ticketSeq = 0;

function readScene(value: unknown): Scene {
  return typeof value === "string" && (SCENES as readonly string[]).includes(value)
    ? (value as Scene)
    : "normal";
}

type TicketBody = { profile?: unknown; cwd?: unknown; arg?: unknown; scene?: unknown };

export async function handleTerminal(
  path: string,
  method: string,
  bodyText: string | null,
): Promise<Response | null> {
  if (path !== "/api/terminal/ticket") return null;
  if (method !== "POST") return errorResponse(405, "method_not_allowed", "（mock）终端票据只支持 POST。");

  let body: TicketBody;
  try {
    body = bodyText ? (JSON.parse(bodyText) as TicketBody) : {};
  } catch {
    return errorResponse(400, "bad_request", "请求体不是合法 JSON。");
  }

  const scene = readScene(body.scene);
  const profile = typeof body.profile === "string" ? body.profile : "";
  const cwdRaw = typeof body.cwd === "string" ? body.cwd.trim() : "";
  const arg = typeof body.arg === "string" ? body.arg.trim() : "";

  if (scene === "too_many_terminals") {
    return errorResponse(429, "too_many_terminals", "（mock）已有 1 条终端在跑（MISAKA_WEB_TERMINAL_MAX=1）。");
  }
  if (scene === "pty_unavailable") {
    return errorResponse(501, "pty_unavailable", "（mock）本机没有可用的 PTY。");
  }
  if (scene === "bad_profile") {
    return errorResponse(422, "bad_profile", "（mock）服务端不认识这个 profile。");
  }

  if (!(PROFILES as string[]).includes(profile)) {
    return errorResponse(
      422,
      "bad_profile",
      `未知 profile：${profile === "" ? "（空）" : profile}。可选 shell / misaka / panel / attach。`,
    );
  }
  if (cwdRaw.startsWith("/") && !cwdRaw.startsWith(WORKSPACE_ROOT)) {
    return errorResponse(422, "cwd_outside", `cwd 越界：${cwdRaw} 不在工作区根内。`);
  }
  if (profile === "attach" && arg === "") {
    return errorResponse(422, "bad_arg", "attach 必须带会话路径 arg（misaka chat --attach --session <arg>）。");
  }

  ticketSeq += 1;
  const ticket = `mock-ticket-${ticketSeq}`;
  const cwd = cwdRaw === "" ? WORKSPACE_ROOT : cwdRaw;
  TICKETS.set(ticket, { profile: profile as TerminalProfile, cwd, scene });
  return jsonResponse({
    ticket,
    ws_url: `/api/terminal/ws?ticket=${encodeURIComponent(ticket)}`,
    expires_in: 30,
    profile,
    cwd,
    cols: 80,
    rows: 24,
    mode: "pty",
  });
}

/* ------------------------------------------------------------------ 假 WebSocket */

type ClientFrame = { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };

const HELP = [
  "（mock）演示命令：",
  "  help    打印这段说明",
  "  clear   清屏",
  "  exit    发一帧 exit（退出码 0）",
  "  misaka  假回显，演示普通输出",
  "按键会逐字符回显；缩放窗口会打印新的 cols×rows。",
  "",
].join("\r\n");

/** 组件只用 onopen/onmessage/onclose/onerror、readyState、send()、close()。 */
export class MockTerminalSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  private readonly state: TicketState;
  private readonly timers: number[] = [];
  private closed = false;
  private line = "";

  constructor(url: string) {
    this.url = url;
    const ticket = new URL(url, window.location.origin).searchParams.get("ticket") ?? "";
    this.state = TICKETS.get(ticket) ?? { profile: "shell", cwd: WORKSPACE_ROOT, scene: "normal" };
    TICKETS.delete(ticket); // 一次性票据
    this.later(() => this.open(), 30);
  }

  send(data: string): void {
    if (this.readyState !== 1) return;
    let frame: ClientFrame;
    try {
      frame = JSON.parse(data) as ClientFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object") return;

    if (frame.type === "input" && typeof frame.data === "string") {
      this.input(frame.data);
      return;
    }
    if (frame.type === "resize") {
      const cols = typeof frame.cols === "number" ? frame.cols : 0;
      const rows = typeof frame.rows === "number" ? frame.rows : 0;
      this.emitText(`\r\n\x1b[2m（mock）窗口 → ${cols}×${rows}\x1b[0m\r\n`);
      this.prompt();
      return;
    }
    if (frame.type === "ping") this.emit({ type: "pong" });
  }

  close(): void {
    this.shutdown(1000, "client closed");
  }

  private later(fn: () => void, ms: number): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private open(): void {
    if (this.closed) return;
    this.readyState = 1;
    this.onopen?.(new Event("open"));
    const { profile, cwd, scene } = this.state;

    this.emit({
      type: "output",
      data:
        "\x1b[1mMISAKA 终端（mock：本地假帧，不连真 PTY）\x1b[0m\r\n" +
        `profile=${profile}  cwd=${cwd}  scope=${scene}\r\n`,
    });

    if (scene === "ticket_expired" || scene === "terminal_disabled") {
      this.later(() => {
        this.emit({
          type: "error",
          code: scene,
          message:
            scene === "ticket_expired"
              ? "（mock）票据已过期或已被使用。"
              : "（mock）服务端没有开启终端（MISAKA_WEB_TERMINAL=0）。",
        });
        this.shutdown(1008, scene);
      }, 220);
      return;
    }
    if (scene === "drop") {
      this.later(() => this.shutdown(1006, "服务端无声断开"), 500);
      return;
    }
    if (scene === "exit1") {
      this.later(() => {
        this.emitText("（mock）演示一次失败退出：exit 1\r\n");
        this.emit({ type: "exit", code: 1 });
        this.shutdown(1000, "exit 1");
      }, 400);
      return;
    }

    this.emitText(HELP);
    this.prompt();
  }

  private input(data: string): void {
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this.lineEnd();
        continue;
      }
      if (ch === "\u007f") {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.emitText("\b \b");
        }
        continue;
      }
      if (ch === "\u0003") {
        this.line = "";
        this.emitText("^C\r\n");
        this.prompt();
        continue;
      }
      if (ch < " ") continue;
      this.line += ch;
      this.emitText(ch);
    }
  }

  private lineEnd(): void {
    const command = this.line.trim();
    this.line = "";
    this.emitText("\r\n");
    if (this.closed) return;

    if (command === "exit" || command === "quit" || command === "/exit") {
      this.emitText("（mock）演示退出码 0。\r\n");
      this.emit({ type: "exit", code: 0 });
      this.shutdown(1000, "normal");
      return;
    }
    if (command === "clear") {
      this.emitText("\x1b[2J\x1b[H");
      this.prompt();
      return;
    }
    if (command === "help") {
      this.emitText(HELP);
      this.prompt();
      return;
    }
    if (command !== "") {
      this.emitText(`（mock 回显）${command}\r\n`);
    }
    this.prompt();
  }

  private prompt(): void {
    this.emitText("misaka@mock:~$ ");
  }

  private emitText(text: string): void {
    this.emit({ type: "output", data: text });
  }

  private emit(frame: TerminalFrameOut): void {
    if (this.closed) return;
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  private shutdown(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.length = 0;
    this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent);
  }
}

/**
 * 只把 `/api/terminal/ws` 路由到假帧；其它 URL 仍然交给真 WebSocket ——
 * 直接整体替换 window.WebSocket 会顺手弄死 vite 的 HMR 客户端（它也 new WebSocket）。
 */
export function installMockWebSocket(): void {
  const Real = window.WebSocket;
  function Routed(url: string | URL, protocols?: string | string[]): WebSocket {
    if (String(url).includes("/api/terminal/ws")) {
      return new MockTerminalSocket(String(url)) as unknown as WebSocket;
    }
    return protocols === undefined ? new Real(url) : new Real(url, protocols);
  }
  Object.assign(Routed, {
    CONNECTING: Real.CONNECTING,
    OPEN: Real.OPEN,
    CLOSING: Real.CLOSING,
    CLOSED: Real.CLOSED,
  });
  const target = window as unknown as { WebSocket: typeof WebSocket };
  target.WebSocket = Routed as unknown as typeof WebSocket;
}
