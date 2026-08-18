import { fmtMove, pnlColor } from "@/lib/format";

/**
 * A percentage move, coloured and signed — or an explicit dash when the window
 * cannot be computed. Never renders 0% to stand in for missing data.
 */
export default function Change({
  changePct,
  change,
  currency = "USD",
  className = "",
  title,
}: {
  changePct: number | null | undefined;
  change?: number | null;
  currency?: string;
  className?: string;
  title?: string;
}) {
  const missing = changePct == null && !(currency.toUpperCase() === "PCT" && change != null);
  return (
    <span
      className={`tabular-nums ${missing ? "text-neutral-400 dark:text-neutral-600" : pnlColor(changePct)} ${className}`}
      title={title ?? (missing ? "Insufficient data for this period" : undefined)}
    >
      {fmtMove(changePct, change, currency)}
    </span>
  );
}
