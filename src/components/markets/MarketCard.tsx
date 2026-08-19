import Link from "next/link";
import { fmtPrice } from "@/lib/format";
import Change from "./Change";
import Sparkline from "./Sparkline";
import { marketMove, type MarketView } from "@/lib/markets/view";
import type { Period } from "@/lib/markets/performance";

/**
 * One market, summarised: where it stands, how it has moved over three windows,
 * and how broad the move was.
 *
 * The headline number is the market's representative asset (the S&P for stocks,
 * BTC for crypto) where one exists; otherwise it is the median across the
 * market's benchmarks, which is the honest read for something like commodities
 * where no single asset stands for the whole. The card says which it used.
 */
export default function MarketCard({ view, period }: { view: MarketView; period: Period }) {
  const headline = view.headline;
  const move = marketMove(view, period);
  const breadth = view.advancers + view.decliners;

  return (
    <Link
      href={`/markets/${view.market}`}
      className="group flex flex-col rounded-xl border border-line bg-surface p-4 transition-colors hover:border-neutral-300 dark:hover:border-neutral-700"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{view.label}</div>
          <div className="truncate text-xs text-muted">{view.blurb}</div>
        </div>
        {headline && headline.spark.length > 1 && (
          <Sparkline points={headline.spark} width={72} height={26} className="shrink-0 opacity-80" />
        )}
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums">
          {headline ? fmtPrice(headline.price, headline.currency) : "—"}
        </span>
        <Change
          changePct={move.changePct}
          change={move.change}
          currency={move.currency}
          className="text-sm font-medium"
          title={
            move.median
              ? `Median move across ${view.label} benchmarks`
              : `${headline?.name ?? ""} over this period`
          }
        />
      </div>

      <div className="mt-0.5 text-xs text-muted">
        {move.median ? "median across market" : (headline?.name ?? "")}
      </div>

      {breadth > 0 && (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted">
          <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-surface-raised">
            <span
              className="bg-gain"
              style={{ width: `${(view.advancers / breadth) * 100}%` }}
              aria-hidden
            />
            <span
              className="bg-loss"
              style={{ width: `${(view.decliners / breadth) * 100}%` }}
              aria-hidden
            />
          </span>
          <span className="tabular-nums">
            {view.advancers}↑ {view.decliners}↓
          </span>
        </div>
      )}
    </Link>
  );
}
