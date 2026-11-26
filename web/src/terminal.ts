/** M7 终端（§3.8）：ws 地址规整、错误帧人话、xterm 主题取自现有 CSS 变量。 */
import type { ITheme } from "@xterm/xterm";
import { API_BASE } from "./env";

/**
 * 服务端给的 ws_url 可能是绝对的 (`wss://host/...`) 或相对的 (`/api/terminal/ws?ticket=…`)。
 * 相对的按 API_BASE 解析，再把 http(s) 换成 ws(s)。
 */
export function resolveTerminalWsUrl(raw: string): string {
  if (/^wss?:\/\//i.test(raw)) return raw;
  const configured = API_BASE === "" ? null : new URL(API_BASE, window.location.origin);
  const origin = configured ? configured.origin : window.location.origin;
  const basePath = configured ? configured.pathname.replace(/\/+$/, "") : "";
  const path = raw.startsWith("/") ? raw : `${basePath}/${raw}`;
  const url = new URL(path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/* ------------------------------------------------------------------ 主题 */

const DARK_ANSI = [
  "#1b2331", "#ff7b72", "#7ee787", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#c9d1d9",
  "#3b4a5e", "#ffa198", "#9be9a8", "#f2cc60", "#a5d6ff", "#e2c5ff", "#8be9fd", "#f0f6fc",
];

const LIGHT_ANSI = [
  "#243040", "#c62828", "#1b8f5f", "#9a6b00", "#2f6df6", "#7b3fbf", "#0d7480", "#5a6673",
  "#3d4a5c", "#e53935", "#2aa76f", "#b57f00", "#4b86ff", "#9657d8", "#128b98", "#10151c",
];

function readVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value === "" ? fallback : value;
}

/** 从 --bg 的相对亮度判断当前是深色还是浅色（不依赖 data-theme 的具体取值）。 */
function backgroundIsDark(background: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(background.trim());
  if (!hex) return true;
  const value = Number.parseInt(hex[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

/** xterm 的主题跟着应用走：底色用 --bg-elevated，与终端容器保持同一块颜色。 */
export function readXtermTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const background = readVar(styles, "--bg-elevated", "#141922");
  const dark = backgroundIsDark(background);
  const ansi = dark ? DARK_ANSI : LIGHT_ANSI;
  const foreground = readVar(styles, "--fg", dark ? "#e8edf4" : "#10151c");
  return {
    background,
    foreground,
    cursor: readVar(styles, "--accent", foreground),
    cursorAccent: background,
    selectionBackground: readVar(styles, "--accent-soft", dark ? "#1c2740" : "#e4ecff"),
    selectionForeground: foreground,
    black: ansi[0],
    red: ansi[1],
    green: ansi[2],
    yellow: ansi[3],
    blue: ansi[4],
    magenta: ansi[5],
    cyan: ansi[6],
    white: ansi[7],
    brightBlack: ansi[8],
    brightRed: ansi[9],
    brightGreen: ansi[10],
    brightYellow: ansi[11],
    brightBlue: ansi[12],
    brightMagenta: ansi[13],
    brightCyan: ansi[14],
    brightWhite: ansi[15],
  };
}

/** data-theme 变化与系统深浅色切换都要重算主题；返回取消订阅。 */
export function watchThemeChange(handler: () => void): () => void {
  const observer = new MutationObserver(handler);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", handler);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", handler);
  };
}

/* ------------------------------------------------------------------ 错误码 */

export type TerminalErrorCopy = { title: string; hint: string; raw: string | null };

const ERROR_COPY: Record<string, { title: string; hint: string }> = {
  too_many_terminals: {
    title: "终端数已达上限",
    hint:
      "服务端 MISAKA_WEB_TERMINAL_MAX（默认 1）已被占满：先关掉另一个终端；空闲 30 分钟或浏览器断开后服务端会自动回收。",
  },
  pty_unavailable: {
    title: "这台服务端没有可用的 PTY",
    hint:
      "Windows 没有 POSIX PTY，只能退化成管道模式：shell 只能跑非交互命令，TUI 不可用。换 Linux/macOS 主机才有真终端。",
  },
  ticket_expired: {
    title: "票据已过期",
    hint: "票据只有 30 秒、且只能用一次。点「重连」会重新取一张票。",
  },
  terminal_disabled: {
    title: "服务端关闭了终端",
    hint: "可能是 MISAKA_WEB_TERMINAL 未开启，或这条终端被服务端回收（空闲超时 / 并发超限）。",
  },
  bad_profile: {
    title: "这个 profile 服务端不认识",
    hint: "可选 shell / misaka / panel / attach；attach 还要填会话目录下的真实路径。",
  },
  bad_cwd: {
    title: "cwd 越界",
    hint: "cwd 必须落在服务端工作区根之内；留空表示根目录本身。",
  },
  cwd_outside: {
    title: "cwd 越界",
    hint: "cwd 必须落在服务端工作区根之内；留空表示根目录本身。",
  },
  bad_arg: {
    title: "attach 缺少会话路径",
    hint: "attach 会执行 misaka chat --attach --session <arg>，arg 必须是会话目录里的真实路径。",
  },
  terminal_no_ticket: {
    title: "WebSocket 没有票据",
    hint: "ws 只认一次性 ticket，不接受 long-lived token：先 POST /api/terminal/ticket。",
  },
  network_error: {
    title: "连不上服务端",
    hint: "检查网络，或 VITE_API_BASE 指向的后端地址是否可达。",
  },
};

/** 把服务端的错误码翻成人话；不认识的码原样保留，不吞。 */
export function describeTerminalError(code: string, message?: string | null): TerminalErrorCopy {
  const copy = ERROR_COPY[code];
  const raw = message ? `${code}: ${message}` : `code: ${code}`;
  return {
    title: copy ? copy.title : `终端出错（${code}）`,
    hint: copy ? copy.hint : "把下面这行 code 与服务端 message 一起报给管理员。",
    raw,
  };
}
