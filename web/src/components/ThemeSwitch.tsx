import { THEME_LABEL, type ThemeMode } from "../theme";

export default function ThemeSwitch({ mode, onCycle }: { mode: ThemeMode; onCycle: () => void }) {
  return (
    <button
      type="button"
      className="btn btn--chip"
      onClick={onCycle}
      aria-label={`切换主题，当前${THEME_LABEL[mode]}`}
      title={`主题：${THEME_LABEL[mode]}（点击切换 自动 → 浅色 → 深色）`}
    >
      <span aria-hidden="true">{mode === "auto" ? "◐" : mode === "dark" ? "●" : "○"}</span>
      <span>{THEME_LABEL[mode]}</span>
    </button>
  );
}
