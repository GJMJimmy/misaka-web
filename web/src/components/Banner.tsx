export type BannerKind = "info" | "warn" | "error";

export type BannerProps = {
  kind: BannerKind;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
};

/** 顶部状态 banner：断线 / 会话失效 / 会话错误都走这里，必须显式。 */
export default function Banner({ kind, text, actionLabel, onAction }: BannerProps) {
  return (
    <div className={`banner banner--${kind}`} role="alert" aria-live="assertive">
      <span className="banner__text">{text}</span>
      {onAction && actionLabel ? (
        <button type="button" className="btn banner__action" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
