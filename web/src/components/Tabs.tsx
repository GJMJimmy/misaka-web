export type TopTab = "sessions" | "research";

type Props = { active: TopTab; onChange: (tab: TopTab) => void };

/** 顶层导航：会话 / 研究。会话页保持 M0 行为不变。 */
export default function Tabs({ active, onChange }: Props) {
  return (
    <nav className="tabs" aria-label="主导航">
      <button
        type="button"
        className={`tab${active === "sessions" ? " tab--active" : ""}`}
        aria-current={active === "sessions" ? "page" : undefined}
        onClick={() => onChange("sessions")}
      >
        会话
      </button>
      <button
        type="button"
        className={`tab${active === "research" ? " tab--active" : ""}`}
        aria-current={active === "research" ? "page" : undefined}
        onClick={() => onChange("research")}
      >
        研究
      </button>
    </nav>
  );
}
