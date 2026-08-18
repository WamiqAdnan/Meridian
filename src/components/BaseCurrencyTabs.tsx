import Link from "next/link";
import { BASE_CURRENCIES, type BaseCurrency } from "@/lib/portfolio";

/**
 * Which currency the portfolio totals in. Pure navigation via `?base=`, matching
 * InvestorSwitcher and PeriodTabs.
 *
 * Every position keeps its own quote currency regardless; this only changes the
 * currency the sums are stated in.
 */
export default function BaseCurrencyTabs({
  basePath,
  selected,
  extraParams,
}: {
  basePath: string;
  selected: BaseCurrency;
  extraParams?: Record<string, string | undefined>;
}) {
  const href = (c: BaseCurrency) => {
    const params = new URLSearchParams({ base: c });
    for (const [k, v] of Object.entries(extraParams ?? {})) if (v) params.set(k, v);
    return `${basePath}?${params}`;
  };

  return (
    <div
      className="inline-flex rounded-lg border border-line bg-surface p-0.5"
      role="group"
      aria-label="Base currency"
    >
      {BASE_CURRENCIES.map((c) => (
        <Link
          key={c}
          href={href(c)}
          aria-current={c === selected ? "true" : undefined}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            c === selected ? "bg-surface-raised text-foreground" : "text-muted hover:text-foreground"
          }`}
        >
          {c}
        </Link>
      ))}
    </div>
  );
}
