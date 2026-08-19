import Link from "next/link";
import { AI_DISCLAIMER } from "@/lib/brand";
import { assetHref } from "@/lib/routes";
import { fmtAgo, fmtPrice } from "@/lib/format";
import type { MatchVia } from "@/lib/news/types";
import {
  accountedFor,
  type Confidence,
  type ResolvedReading,
  type StoredInsight,
  type Verdict,
} from "@/lib/insights/types";
import Change from "@/components/markets/Change";

/**
 * A week's insight, with the line between fact and inference drawn on the page.
 *
 * Every movement is rendered as two things a reader can tell apart at a glance: a
 * **fact** — the move, its size in the asset's own volatility, the close — which
 * came from stored price data and is true; and an **AI inference**, which came from
 * a language model reading headlines and is not. They never share a sentence, and
 * the inference always carries the sources it was drawn from.
 *
 * That separation is the whole point of the panel. An insight that reads "gold fell
 * because the dollar firmed" has already thrown away the thing that makes it safe
 * to show; one that reads "gold fell 3.4% (fact)" above "Reuters reported the
 * dollar firming after the CPI print (inference, from A1)" has not.
 */

const VERDICT_LABEL: Record<Verdict, string> = {
  explained: "Accounted for",
  partial: "Partly accounted for",
  insufficient: "Insufficient data to determine",
};

const VERDICT_STYLE: Record<Verdict, string> = {
  explained: "border-line bg-surface-raised text-foreground",
  partial: "border-dashed border-line text-muted",
  insufficient: "border-dashed border-line text-muted",
};

/** How a source came to be linked, in the words a reader needs to judge it. */
const VIA_LABEL: Record<MatchVia, string> = {
  feed: "filed against this asset by its publisher",
  symbol: "names this ticker",
  name: "names this asset",
  alias: "refers to this asset — a text match, which may be coincidence",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "high confidence",
  medium: "medium confidence",
  low: "low confidence",
};

function Reading({ reading }: { reading: ResolvedReading }) {
  const { fact } = reading;
  return (
    <li className="px-3 py-3">
      {/* FACT — computed from daily closes. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link href={assetHref(fact.assetId)} className="font-medium hover:text-accent">
          {fact.symbol}
        </Link>
        <span className="text-sm text-muted">{fact.name}</span>
        <Change changePct={fact.changePct} currency={fact.currency} className="text-sm font-medium" />
        <span className="text-xs text-muted tabular-nums">
          {Math.abs(fact.zScore).toFixed(1)}σ · own daily σ {fact.sigma.toFixed(2)}%
          {fact.price != null && ` · last ${fmtPrice(fact.price, fact.currency)}`}
        </span>
      </div>

      {/* INFERENCE — a model's reading of the headlines below it. */}
      <div className="mt-2 border-l-2 border-line pl-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`rounded border px-1.5 py-0.5 text-[11px] ${VERDICT_STYLE[reading.verdict]}`}
          >
            {VERDICT_LABEL[reading.verdict]}
          </span>
          {reading.verdict !== "insufficient" && (
            <span className="text-[11px] text-muted">{CONFIDENCE_LABEL[reading.confidence]}</span>
          )}
          <span className="text-[11px] uppercase tracking-wide text-muted">AI inference</span>
        </div>
        <p className="mt-1 text-sm text-muted">{reading.inference}</p>

        {reading.sources.length > 0 && (
          <ul className="mt-2 space-y-1">
            {reading.sources.map((s) => (
              <li key={s.ref} className="text-xs">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                  title={s.via ? VIA_LABEL[s.via] : "a market-wide story, not linked to this asset"}
                >
                  {s.title}
                </a>{" "}
                <span className="text-muted">
                  — {s.source}, {fmtAgo(s.publishedAt)}
                  {s.via ? ` · ${VIA_LABEL[s.via]}` : " · market-wide, not linked to this asset"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

export default function InsightCard({
  insight,
  stale,
  market,
}: {
  insight: StoredInsight;
  stale: boolean;
  market: string;
}) {
  const { explained, total } = accountedFor(insight);
  const body = insight.body;

  return (
    <article className="rounded-xl border border-line bg-surface">
      <header className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Week in review</h3>
          <span className="text-xs text-muted">
            week of {insight.weekStart}
            {stale && " · not yet generated for this week"}
          </span>
        </div>
        <p className="mt-1 text-base font-semibold">{body.headline}</p>
      </header>

      <div className="px-4 py-3">
        <p className="text-sm text-muted">{body.summary}</p>
        <p className="mt-2 text-xs text-muted">
          {total === 0
            ? "Nothing moved unusually enough to need explaining."
            : `${explained} of ${total} unusual ${total === 1 ? "move" : "moves"} accounted for, from ${body.articlesConsidered} ${body.articlesConsidered === 1 ? "headline" : "headlines"}.`}
        </p>
      </div>

      {body.readings.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {body.readings.map((r) => (
            <Reading key={r.ref} reading={r} />
          ))}
        </ul>
      )}

      {body.watchItems.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Worth watching</h4>
          <ul className="mt-1 list-inside list-disc text-sm text-muted">
            {body.watchItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <footer className="border-t border-line px-4 py-2 text-[11px] text-muted">
        <p>{AI_DISCLAIMER}</p>
        <p className="mt-1">
          Written by {insight.model} · {fmtAgo(insight.generatedAt)} ·{" "}
          <Link href={`/news?market=${market}`} className="hover:text-foreground">
            the headlines it read
          </Link>
        </p>
      </footer>
    </article>
  );
}
