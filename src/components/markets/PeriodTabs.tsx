import Link from "next/link";
import { PERIODS, PERIOD_LABEL, type Period } from "@/lib/markets/performance";

/**
 * Window switcher. Pure navigation via `?period=` — no client JS, matching the
 * existing InvestorSwitcher.
 */
export default function PeriodTabs({
  basePath,
  selected,
  extraParams,
}: {
  basePath: string;
  selected: Period;
  extraParams?: Record<string, string | undefined>;
}) {
  const href = (p: Period) => {
    const params = new URLSearchParams({ period: p });
    for (const [k, v] of Object.entries(extraParams ?? {})) if (v) params.set(k, v);
    return `${basePath}?${params}`;
  };

  return (
    <div
      className="inline-flex rounded-lg border border-line bg-surface p-0.5"
      role="group"
      aria-label="Time period"
    >
      {PERIODS.map((p) => (
        <Link
          key={p}
          href={href(p)}
          aria-current={p === selected ? "true" : undefined}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            p === selected
              ? "bg-surface-raised text-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          {PERIOD_LABEL[p]}
        </Link>
      ))}
    </div>
  );
}
