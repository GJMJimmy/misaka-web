import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { MOCK } from "./env";
import { applyThemeMode, readThemeMode } from "./theme";
import "./styles.css";

// 先落主题，避免首帧闪一下浅色再切深色。
applyThemeMode(readThemeMode());

async function bootstrap(): Promise<void> {
  if (MOCK) {
    // 只在 VITE_MOCK=1 时加载：mock 后端替换 fetch + EventSource。
    const { installMockBackend } = await import("./mock");
    installMockBackend();
  }
  const container = document.getElementById("root");
  if (!container) throw new Error("#root 未找到");
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
