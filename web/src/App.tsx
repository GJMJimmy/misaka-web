import { useCallback, useEffect, useState } from "react";
import { ApiError, describeError, listSessions, login, logout, me, writeToken } from "./api";
import AuditView from "./components/AuditView";
import Banner from "./components/Banner";
import LoginView from "./components/LoginView";
import MenuSheet from "./components/MenuSheet";
import NodeDetailView from "./components/NodeDetailView";
import ResearchListView from "./components/ResearchListView";
import RunDetailView from "./components/RunDetailView";
import SessionListView from "./components/SessionListView";
import SessionView from "./components/SessionView";
import SettingsView from "./components/SettingsView";
import Tabs, { type TopTab } from "./components/Tabs";
import TerminalView from "./components/TerminalView";
import ThemeSwitch from "./components/ThemeSwitch";
import { MOCK } from "./env";
import { useServiceWorker } from "./sw";
import { useThemeMode } from "./theme";
import { useAppHeight } from "./useAppHeight";
import { useReminders } from "./useReminders";
import type { Session } from "./types";

const SESSION_HINT = "mw.authed";

/** Remember that this device had a working session, so an offline reload is not a login form. */
function rememberSession(ok: boolean): void {
  try {
    if (ok) localStorage.setItem(SESSION_HINT, "1");
    else localStorage.removeItem(SESSION_HINT);
  } catch {
    /* private mode: no hint, no harm */
  }
}

function rememberedSession(): boolean {
  try {
    return localStorage.getItem(SESSION_HINT) === "1";
  } catch {
    return false;
  }
}

type AuthState = "checking" | "anonymous" | "authenticated";

type Screen =
  | { kind: "list" }
  | { kind: "session"; id: string }
  | { kind: "runs" }
  | { kind: "run"; id: string }
  | { kind: "node"; runId: string; nodeId: string }
  | { kind: "audit" }
  | { kind: "settings" }
  | { kind: "terminal" };

function screenFromHash(): Screen {
  const hash = window.location.hash;
  let match = /^#\/session\/([^/]+)$/.exec(hash);
  if (match) return { kind: "session", id: decodeURIComponent(match[1]) };
  if (/^#\/runs$/.test(hash)) return { kind: "runs" };
  if (/^#\/audit$/.test(hash)) return { kind: "audit" };
  if (/^#\/settings$/.test(hash)) return { kind: "settings" };
  if (/^#\/terminal$/.test(hash)) return { kind: "terminal" };
  match = /^#\/run\/([^/]+)\/node\/([^/]+)$/.exec(hash);
  if (match) {
    return { kind: "node", runId: decodeURIComponent(match[1]), nodeId: decodeURIComponent(match[2]) };
  }
  match = /^#\/run\/([^/]+)$/.exec(hash);
  if (match) return { kind: "run", id: decodeURIComponent(match[1]) };
  return { kind: "list" };
}

function hashOf(screen: Screen): string {
  switch (screen.kind) {
    case "session":
      return `#/session/${encodeURIComponent(screen.id)}`;
    case "runs":
      return "#/runs";
    case "run":
      return `#/run/${encodeURIComponent(screen.id)}`;
    case "node":
      return `#/run/${encodeURIComponent(screen.runId)}/node/${encodeURIComponent(screen.nodeId)}`;
    case "audit":
      return "#/audit";
    case "settings":
      return "#/settings";
    case "terminal":
      return "#/terminal";
    default:
      return "#/sessions";
  }
}

function tabOf(screen: Screen): TopTab | null {
  if (screen.kind === "runs" || screen.kind === "run" || screen.kind === "node") return "research";
  if (screen.kind === "audit" || screen.kind === "settings" || screen.kind === "terminal") return null;
  return "sessions";
}

function backTargetOf(screen: Screen): Screen | null {
  switch (screen.kind) {
    case "session":
      return { kind: "list" };
    case "run":
      return { kind: "runs" };
    case "node":
      return { kind: "run", id: screen.runId };
    case "audit":
      return { kind: "list" };
    case "settings":
      return { kind: "list" };
    case "terminal":
      return { kind: "list" };
    default:
      return null;
  }
}

function titleOf(screen: Screen, sessions: Session[]): string {
  switch (screen.kind) {
    case "session": {
      const found = sessions.find((item) => item.id === screen.id);
      return found?.title?.trim() || found?.id || screen.id;
    }
    case "runs":
      return "研究运行";
    case "run":
      return "研究运行";
    case "node":
      return `节点 ${screen.nodeId}`;
    case "audit":
      return "审计日志";
    case "settings":
      return "设置";
    case "terminal":
      return "终端";
    default:
      return "MISAKA WebUI";
  }
}

export default function App() {
  useAppHeight();
  const [themeMode, cycleTheme] = useThemeMode();
  const { updateReady, applyUpdate, offline } = useServiceWorker();
  const [auth, setAuth] = useState<AuthState>("checking");
  const [screen, setScreen] = useState<Screen>(() => screenFromHash());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [runFlash, setRunFlash] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const reminders = useReminders(auth === "authenticated");

  /* 极简 hash 路由：不引入路由库，只让手机返回键/深链可用。 */
  useEffect(() => {
    const sync = () => setScreen(screenFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const navigate = useCallback((next: Screen) => {
    const hash = hashOf(next);
    if (window.location.hash !== hash) window.location.hash = hash;
    setScreen(next);
  }, []);

  const refreshSessions = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const list = await listSessions();
      setSessions(list);
      rememberSession(true);
      setAuth("authenticated");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        writeToken(null);
        rememberSession(false);
    setAuth("anonymous");
      } else {
        setListError(`读取会话列表失败：${describeError(err)}`);
      }
    } finally {
      setListLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await me();
        if (alive) {
          rememberSession(true);
          setAuth("authenticated");
        }
      } catch (err) {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 401) {
          rememberSession(false);
          setAuth("anonymous");
          return;
        }
        // Offline or unreachable: a remembered session keeps the shell instead of a login form.
        setAuth(rememberedSession() ? "authenticated" : "anonymous");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (auth === "authenticated") void refreshSessions();
  }, [auth, refreshSessions]);

  const handleRunCreated = useCallback(
    (runId: string, notice: string) => {
      setRunFlash(notice);
      navigate({ kind: "run", id: runId });
    },
    [navigate],
  );

  const handleAuthLost = useCallback(() => {
    writeToken(null);
    setAuth("anonymous");
    setSessions([]);
    navigate({ kind: "list" });
  }, [navigate]);

  const handleLogin = useCallback(
    async (token: string) => {
      await login(token);
      writeToken(token);
      setAuth("authenticated");
      navigate({ kind: "list" });
    },
    [navigate],
  );

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } finally {
      handleAuthLost();
    }
  }, [handleAuthLost]);

  if (auth === "checking") {
    return (
      <div className="boot" role="status">
        正在连接 MISAKA Web…
      </div>
    );
  }

  if (auth === "anonymous") {
    return (
      <div className="app app--login">
        <LoginView onSubmit={handleLogin} mock={MOCK} />
      </div>
    );
  }

  const back = backTargetOf(screen);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__lead">
          {back ? (
            <button
              type="button"
              className="btn btn--icon"
              onClick={() => navigate(back)}
              aria-label="返回上一级"
            >
              <span aria-hidden="true">←</span>
            </button>
          ) : (
            <span className="topbar__mark" aria-hidden="true">
              M
            </span>
          )}
          <h1 className="topbar__title">{titleOf(screen, sessions)}</h1>
        </div>
        <div className="topbar__trail">
          <ThemeSwitch mode={themeMode} onCycle={cycleTheme} />
          <button
            type="button"
            className="btn btn--icon"
            onClick={() => setMenuOpen(true)}
            aria-label="打开菜单"
          >
            <span aria-hidden="true">⋯</span>
          </button>
        </div>
      </header>

      {offline ? (
        <Banner kind="warn" text="离线：显示的是缓存壳（接口与文件此时不可达）。" />
      ) : null}

      {updateReady ? (
        <Banner
          kind="info"
          text="有新版本：Service Worker 已就绪，刷新即可用上。"
          actionLabel="点此刷新"
          onAction={applyUpdate}
        />
      ) : null}

      <Tabs
        active={tabOf(screen)}
        researchDot={reminders.counts.attention}
        onChange={(tab) => navigate(tab === "sessions" ? { kind: "list" } : { kind: "runs" })}
      />

      <main className="screen">
        {screen.kind === "session" ? (
          <SessionView
            key={screen.id}
            sessionId={screen.id}
            session={sessions.find((item) => item.id === screen.id) ?? null}
            onBack={() => navigate({ kind: "list" })}
            onAuthLost={handleAuthLost}
          />
        ) : screen.kind === "runs" ? (
          <ResearchListView
            onOpen={(id) => navigate({ kind: "run", id })}
            onCreatedRun={handleRunCreated}
            onAuthLost={handleAuthLost}
          />
        ) : screen.kind === "run" ? (
          <RunDetailView
            key={screen.id}
            runId={screen.id}
            onOpenNode={(nodeId) => navigate({ kind: "node", runId: screen.id, nodeId })}
            onAuthLost={handleAuthLost}
            flash={runFlash}
            onFlashHandled={() => setRunFlash(null)}
          />
        ) : screen.kind === "node" ? (
          <NodeDetailView
            key={`${screen.runId}/${screen.nodeId}`}
            runId={screen.runId}
            nodeId={screen.nodeId}
            onAuthLost={handleAuthLost}
          />
        ) : screen.kind === "audit" ? (
          <AuditView onAuthLost={handleAuthLost} />
        ) : screen.kind === "settings" ? (
          <SettingsView
            onAuthLost={handleAuthLost}
            onGoResearch={() => navigate({ kind: "runs" })}
          />
        ) : screen.kind === "terminal" ? (
          <TerminalView mock={MOCK} onAuthLost={handleAuthLost} />
        ) : (
          <SessionListView
            sessions={sessions}
            loading={listLoading}
            error={listError}
            onRefresh={() => void refreshSessions()}
            onOpen={(id) => navigate({ kind: "session", id })}
            onLogout={() => void handleLogout()}
          />
        )}
      </main>

      {menuOpen ? (
        <MenuSheet
          onClose={() => setMenuOpen(false)}
          onOpenAudit={() => {
            setMenuOpen(false);
            navigate({ kind: "audit" });
          }}
          onOpenSettings={() => {
            setMenuOpen(false);
            navigate({ kind: "settings" });
          }}
          onOpenTerminal={() => {
            setMenuOpen(false);
            navigate({ kind: "terminal" });
          }}
          onLogout={() => {
            setMenuOpen(false);
            void handleLogout();
          }}
          notificationSupported={reminders.notificationSupported}
          permission={reminders.permission}
          onEnableReminders={() => void reminders.requestPermission()}
          attention={reminders.counts.attention}
          mock={MOCK}
        />
      ) : null}
    </div>
  );
}