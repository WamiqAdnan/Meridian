import Link from "next/link";
import { AI_DISCLAIMER } from "@/lib/brand";
import { fmtAgo } from "@/lib/format";
import { MARKET_META } from "@/lib/markets/types";
import { marketHref } from "@/lib/routes";
import type { InsightDigest } from "@/lib/insights/view";

/**
 * Every market's latest insight, one line each.
 *
 * The overview's version of `InsightCard`, and deliberately thinner: a headline, a
 * link, and the honest count of how much was actually accounted for. The card on
 * the market page is where the movements, the inferences and the citations live —
 * a summary of a summary would be prose about prose, with the fact/inference line
 * blurred exactly where it matters most.
 *
 * What survives the compression is the count. "0 of 2 accounted for" is the answer
 * most weeks, and it is the number that stops a row of confident-looking headlines
 * reading as though the week had been explained.
 */
export default function InsightDigest({ digest }: { digest: InsightDigest }) {
  const { entries, missing, weekStart, backend } = digest;

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line p-5 text-sm text-muted">
        <p className="font-medium text-foreground">No insights generated yet.</p>
        <p className="mt-1">
          An insight explains a market&rsquo;s unusual moves from the headlines retrieved against
          them, and it never runs on a page view — one generation is up to three model calls. Run{" "}
          <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs">
            npm run insights:generate
          </code>
          , or use the button on any market page.
        </p>
        <p className="mt-2">
          {backend ? (
            <>
              Generation would run against <span className="text-foreground">{backend}</span>.
            </>
          ) : (
            "No model is configured, so nothing can be generated yet."
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface">
      <ul className="divide-y divide-line">
        {entries.map((entry) => (
          <li key={entry.market} className="px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <Link
                href={marketHref(entry.market)}
                className="text-sm font-semibold hover:text-accent"
              >
                {entry.label}
              </Link>
              <span className="text-xs text-muted">
                week of {entry.weekStart}
                {entry.stale && " · not yet generated for this week"}
              </span>
            </div>
            <p className="mt-1 text-sm">{entry.headline}</p>
            <p className="mt-1 text-xs text-muted">
              {entry.total === 0
                ? "Nothing moved unusually enough to need explaining."
                : `${entry.explained} of ${entry.total} unusual ${entry.total === 1 ? "move" : "moves"} accounted for, from ${entry.articlesConsidered} ${entry.articlesConsidered === 1 ? "headline" : "headlines"}.`}{" "}
              <span className="uppercase tracking-wide">AI inference</span> ·{" "}
              {entry.model} · {fmtAgo(entry.generatedAt)}
            </p>
          </li>
        ))}
      </ul>

      <footer className="border-t border-line px-4 py-2 text-[11px] text-muted">
        <p>{AI_DISCLAIMER}</p>
        {missing.length > 0 && (
          <p className="mt-1">
            No insight yet for {missing.map((m) => MARKET_META[m].label).join(", ")} — a market with
            nothing unusual to explain is skipped rather than written about.
          </p>
        )}
        <p className="mt-1">Current week is {weekStart}.</p>
      </footer>
    </div>
  );
}
