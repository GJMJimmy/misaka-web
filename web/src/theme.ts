import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "auto" | "light" | "dark";

const KEY = "misaka.web.theme";
const ORDER: ThemeMode[] = ["auto", "light", "dark"];

export const THEME_LABEL: Record<ThemeMode, string> = {
  auto: "自动",
  light: "浅色",
  dark: "深色",
};

export function readThemeMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === "light" || raw === "dark" || raw === "auto") return raw;
  } catch {
    /* 忽略 */
  }
  return "auto";
}

/** data-theme 决定 CSS 变量：auto 时由 prefers-color-scheme 决定。 */
export function applyThemeMode(mode: ThemeMode): void {
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode === "auto" ? "light dark" : mode;
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    /* 忽略 */
  }
}

export function useThemeMode(): [ThemeMode, () => void] {
  const [mode, setMode] = useState<ThemeMode>(() => readThemeMode());

  useEffect(() => {
    applyThemeMode(mode);
  }, [mode]);

  const cycle = useCallback(() => {
    setMode((prev) => ORDER[(ORDER.indexOf(prev) + 1) % ORDER.length]);
  }, []);

  return [mode, cycle];
}
