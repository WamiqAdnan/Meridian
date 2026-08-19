import Link from "next/link";
import { INVESTORS } from "@/lib/investors";

/**
 * Switch the view between the combined portfolio ("Together") and each individual
 * investor. Pure navigation via `?owner=` — no client JS needed.
 *
 * A named `nav` of links rather than an ARIA tablist, for the reason set out in
 * `PeriodTabs`: these navigate, so `aria-current="page"` is the honest marker and
 * a tablist would promise keyboard behaviour that a full page load cannot honour.
 *
 * Painted from the design tokens like everything else. It had kept a hand-rolled
 * `neutral-*` palette with its own dark-mode overrides since before the tokens
 * existed, which made it the one control on the overview that did not match the
 * two beside it.
 */
export default function InvestorSwitcher({
  basePath,
  selected,
  extraParams,
}: {
  basePath: string;
  selected: string | null; // null = Together (combined)
  /** Other query params to carry across, so switching owner keeps the period. */
  extraParams?: Record<string, string | undefined>;
}) {
  const options: { label: string; owner: string | null }[] = [
    { label: "Together", owner: null },
    ...INVESTORS.map((name) => ({ label: name, owner: name as string })),
  ];

  const href = (owner: string | null) => {
    const params = new URLSearchParams();
    if (owner) params.set("owner", owner);
    for (const [key, value] of Object.entries(extraParams ?? {})) if (value) params.set(key, value);
    const query = params.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  return (
    <nav
      className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-sm"
      aria-label="Investor"
    >
      {options.map((o) => {
        const active = o.owner === selected;
        return (
          <Link
            key={o.label}
            href={href(o.owner)}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1 font-medium transition-colors ${
              active ? "bg-surface-raised text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {o.label}
          </Link>
        );
      })}
    </nav>
  );
}
