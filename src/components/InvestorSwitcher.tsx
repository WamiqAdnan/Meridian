import Link from "next/link";
import { INVESTORS } from "@/lib/investors";

/**
 * Segmented control to switch the view between the combined portfolio ("Together")
 * and each individual investor. Pure navigation via `?owner=` — no client JS needed.
 */
export default function InvestorSwitcher({
  basePath,
  selected,
}: {
  basePath: string;
  selected: string | null; // null = Together (combined)
}) {
  const options: { label: string; owner: string | null }[] = [
    { label: "Together", owner: null },
    ...INVESTORS.map((name) => ({ label: name, owner: name as string })),
  ];

  return (
    <div className="inline-flex rounded-lg border border-neutral-300 p-0.5 text-sm dark:border-neutral-700">
      {options.map((o) => {
        const active = o.owner === selected;
        const href = o.owner ? `${basePath}?owner=${encodeURIComponent(o.owner)}` : basePath;
        return (
          <Link
            key={o.label}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1 font-medium transition-colors ${
              active
                ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            }`}
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}
