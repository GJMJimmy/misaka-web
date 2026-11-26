import { statusTone } from "../format";

type Props = { status?: string | null; prefix?: string };

/** 状态徽标：状态 → 语义色（ok / run / warn / err / muted）。 */
export default function StatusChip({ status, prefix }: Props) {
  const value = (status ?? "").trim();
  if (value === "") return null;
  return <span className={`chip chip--tone-${statusTone(value)}`}>{prefix ? `${prefix} ${value}` : value}</span>;
}
