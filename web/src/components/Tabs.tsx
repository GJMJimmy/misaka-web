export type TopTab = "sessions" | "research";

type Props = {
  /** null = 当前在其它页面（例如审计），两个 tab 都不高亮。 */
  active: TopTab | null;
  onChange: (tab: TopTab) => void;
  /** 研究 tab 上的小圆点：待审批 + 失败的数量。 */
  researchDot?: number;
};

/** 顶层导航：会话 / 研究。会话页保持 M0 行为不变。 */
export default function Tabs({ active, onChange, researchDot = 0 }: Props) {
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
        {researchDot > 0 ? (
          <span className="tab__dot" aria-label={`${researchDot} 项待办`} title={`${researchDot} 项待办`}>
            {researchDot > 9 ? "9+" : researchDot}
          </span>
        ) : null}
      </button>
    </nav>
  );
}
