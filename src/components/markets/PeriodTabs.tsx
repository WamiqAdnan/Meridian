import Link from "next/link";
import { PERIODS, PERIOD_LABEL, type Period } from "@/lib/markets/performance";

/**
 * Window switcher. Pure navigation via `?period=` — no client JS, matching the
 * existing InvestorSwitcher.
 *
 * A `nav` of links, **not** an ARIA tablist. These look like tabs and are not:
 * each one is an `<a>` to a different URL that the server re-renders in full.
 * `role="tablist"` would promise arrow-key traversal, a roving tabindex and a
 * `tabpanel` to control — none of which exist here, and two of which cannot,
 * because activating one of these replaces the document. A named `nav` with
 * `aria-current="page"` on the selected link is what a set of links where one is
 * current actually is, and it matches the market filter on `/news`.
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
    <nav
      className="inline-flex rounded-lg border border-line bg-surface p-0.5"
      aria-label="Time period"
    >
      {PERIODS.map((p) => (
        <Link
          key={p}
          href={href(p)}
          aria-current={p === selected ? "page" : undefined}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            p === selected
              ? "bg-surface-raised text-foreground"
              : "text-muted hover:text-foreground"
          }`}
        >
          {PERIOD_LABEL[p]}
        </Link>
      ))}
    </nav>
  );
}
