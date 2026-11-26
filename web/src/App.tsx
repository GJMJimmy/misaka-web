import { useCallback, useEffect, useState } from "react";
import { ApiError, describeError, listSessions, login, logout, me, writeToken } from "./api";
import LoginView from "./components/LoginView";
import SessionListView from "./components/SessionListView";
import SessionView from "./components/SessionView";
import ThemeSwitch from "./components/ThemeSwitch";
import { MOCK } from "./env";
import { useThemeMode } from "./theme";
import { useAppHeight } from "./useAppHeight";
import type { Session } from "./types";

type AuthState = "checking" | "anonymous" | "authenticated";
type Screen = { kind: "list" } | { kind: "session"; id: string };

function screenFromHash(): Screen {
  const match = /^#\/session\/([^/]+)$/.exec(window.location.hash);
  return match ? { kind: "session", id: decodeURIComponent(match[1]) } : { kind: "list" };
}

function hashOf(screen: Screen): string {
  return screen.kind === "session" ? `#/session/${encodeURIComponent(screen.id)}` : "#/sessions";
}

export default function App() {
  useAppHeight();
  const [themeMode, cycleTheme] = useThemeMode();
  const [auth, setAuth] = useState<AuthState>("checking");
  const [screen, setScreen] = useState<Screen>(() => screenFromHash());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

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
      setAuth("authenticated");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        writeToken(null);
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
        if (alive) setAuth("authenticated");
      } catch {
        if (alive) setAuth("anonymous");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (auth === "authenticated") void refreshSessions();
  }, [auth, refreshSessions]);

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

  const active = screen.kind === "session" ? sessions.find((item) => item.id === screen.id) ?? null : null;
  const title =
    screen.kind === "session" ? active?.title?.trim() || active?.id || screen.id : "MISAKA WebUI";

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__lead">
          {screen.kind === "session" ? (
            <button type="button" className="btn btn--icon" onClick={() => navigate({ kind: "list" })} aria-label="返回会话列表">
              <span aria-hidden="true">←</span>
            </button>
          ) : (
            <span className="topbar__mark" aria-hidden="true">
              M
            </span>
          )}
          <h1 className="topbar__title">{title}</h1>
        </div>
        <div className="topbar__trail">
          {MOCK ? <span className="chip chip--mock">MOCK</span> : null}
          <ThemeSwitch mode={themeMode} onCycle={cycleTheme} />
        </div>
      </header>

      <main className="screen">
        {screen.kind === "session" ? (
          <SessionView
            key={screen.id}
            sessionId={screen.id}
            session={active}
            onBack={() => navigate({ kind: "list" })}
            onAuthLost={handleAuthLost}
          />
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
    </div>
  );
}
