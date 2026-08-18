import type { Metadata } from "next";
import { PERIOD_LABEL, PERIODS, type Period } from "@/lib/markets/performance";
import { buildMarketViews, crossMarketMovers, loadAssetViews, newestFetch } from "@/lib/markets/view";
import { refreshIfStale } from "@/lib/markets/refresh";
import { fmtAgo } from "@/lib/format";
import MarketCard from "@/components/markets/MarketCard";
import MoversList from "@/components/markets/MoversList";
import PeriodTabs from "@/components/markets/PeriodTabs";
import RefreshMarketsButton from "@/components/markets/RefreshMarketsButton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Markets",
  description: "What is happening across markets right now.",
};

function toPeriod(v: unknown): Period {
  return typeof v === "string" && (PERIODS as readonly string[]).includes(v) ? (v as Period) : "week";
}

/**
 * The cross-market dashboard: one card per market, then the biggest movers
 * across all of them at once.
 *
 * Renders from stored data and kicks off a background-ish refresh only when the
 * cache has gone stale, so opening the page is a database read rather than
 * ninety upstream requests.
 */
export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const period = toPeriod((await searchParams).period);

  await refreshIfStale();

  const { assets } = await loadAssetViews();
  const views = buildMarketViews(assets, period);
  const movers = crossMarketMovers(assets, period, 6);
  const updated = newestFetch(assets);

  const hasData = assets.length > 0;
  const withHistory = assets.filter((a) => a.performance.periods[period]).length;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Markets</h1>
          <p className="mt-1 text-sm text-muted">
            What is happening across markets right now ·{" "}
            <span title={updated?.toLocaleString() ?? undefined}>
              prices updated {fmtAgo(updated)}
            </span>
          </p>
        </div>
        <RefreshMarketsButton />
      </header>

      {!hasData ? (
        <div className="rounded-xl border border-dashed border-line p-10 text-center">
          <p className="text-sm font-medium">No market data yet.</p>
          <p className="mt-1 text-sm text-muted">
            Run <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs">npm run market:backfill</code>{" "}
            to seed the catalogue and pull a year of daily prices.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <PeriodTabs basePath="/markets" selected={period} />
            <p className="text-xs text-muted">
              Showing {PERIOD_LABEL[period]} moves · {withHistory} of {assets.length} assets have
              enough history for this window
            </p>
          </div>

          <section aria-labelledby="overview-heading" className="mb-8">
            <h2 id="overview-heading" className="sr-only">
              Market overview
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {views.map((view) => (
                <MarketCard key={view.market} view={view} period={period} />
              ))}
            </div>
          </section>

          <section aria-labelledby="movers-heading">
            <h2 id="movers-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
              Biggest movers · {PERIOD_LABEL[period]} · across all markets
            </h2>
            <div className="grid gap-4 lg:grid-cols-3">
              <MoversList title="Top gainers" movers={movers.gainers} />
              <MoversList title="Top losers" movers={movers.losers} />
              <MoversList
                title="Largest absolute moves"
                movers={movers.biggestAbsolute}
                emptyLabel="Not enough price history yet."
              />
            </div>
            <p className="mt-3 text-xs text-muted">
              Absolute moves are in each asset&rsquo;s own quote currency and are not comparable
              across currencies — they rank size of move within an asset, not between assets.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
