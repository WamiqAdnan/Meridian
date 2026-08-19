import type { Metadata } from "next";
import Link from "next/link";
import { loadPortfolio } from "@/lib/portfolio-view";
import { refreshIfStale } from "@/lib/markets/refresh";
import { buildMarketViews, crossMarketMovers, loadAssetViews, newestFetch } from "@/lib/markets/view";
import { PERIODS, PERIOD_LABEL, type Period } from "@/lib/markets/performance";
import { ingestIfStale } from "@/lib/news/ingest";
import { loadNewsFeed } from "@/lib/news/view";
import { loadInsightDigest } from "@/lib/insights/view";
import { fmtAgo, fmtMoney, fmtPct, fmtUnits, fmtWeight, pnlColor } from "@/lib/format";
import { assetHref } from "@/lib/routes";
import AllocationDonut from "@/components/AllocationDonut";
import InvestorSwitcher from "@/components/InvestorSwitcher";
import MarketCard from "@/components/markets/MarketCard";
import MoversList from "@/components/markets/MoversList";
import PeriodTabs from "@/components/markets/PeriodTabs";
import RefreshMarketsButton from "@/components/markets/RefreshMarketsButton";
import NewsList from "@/components/news/NewsList";
import InsightDigest from "@/components/insights/InsightDigest";
import { toOwnerFilter } from "@/lib/investors";
import { DEFAULT_BASE_CURRENCY } from "@/lib/portfolio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Overview",
  description: "The portfolio, the markets and the week's insights on one screen.",
};

/** Largest positions shown before deferring to the portfolio page. */
const TOP_POSITIONS = 6;

function toPeriod(v: unknown): Period {
  return typeof v === "string" && (PERIODS as readonly string[]).includes(v) ? (v as Period) : "week";
}

/**
 * The overview: what you own, what the markets did, and what the week's insights
 * made of it.
 *
 * This page was the holdings-and-import screen until every number on it had
 * somewhere to lead. It now summarises and links rather than listing: the whole
 * book lives on `/portfolio`, one asset on `/assets/[id]`, and statement import —
 * which is a task, not a status — moved next to manual trade entry where it belongs.
 *
 * Prices and news refresh themselves when stale. **Insights do not**: the digest is
 * read from storage, because generating one is up to three model calls per market
 * and a page render must never pay for that. See `insights/view.ts`.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string; period?: string }>;
}) {
  const query = await searchParams;
  const owner = toOwnerFilter(query.owner); // null = Together (combined)
  const period = toPeriod(query.period);
  const base = DEFAULT_BASE_CURRENCY;

  await refreshIfStale();
  await ingestIfStale();

  // One asset snapshot for the whole page. This used to sit inside the
  // `Promise.all` below alongside `loadPortfolio`, which loads assets itself —
  // so every render read ~31k `PriceBar` rows and ran the performance maths
  // twice, and the cards and the holdings could in principle be priced from two
  // different moments. Handing the same snapshot to `loadPortfolio` fixes both.
  const [views, news, digest] = await Promise.all([
    loadAssetViews(),
    loadNewsFeed({ limit: 6 }),
    loadInsightDigest(),
  ]);
  const { assets } = views;
  // Waits on the snapshot by construction; the trade query it still runs is 64
  // rows, which is not worth the contortion of overlapping it with the load.
  const portfolio = await loadPortfolio({ owner, baseCurrency: base, views });

  const { positions, totals, byAsset, best, worst, warnings, pricesFetchedAt } = portfolio;
  const marketViews = buildMarketViews(assets, period);
  const movers = crossMarketMovers(assets, period, 5);
  const marketsUpdated = newestFetch(assets);

  const hasHoldings = positions.length > 0;
  const largest = [...positions]
    .filter((p) => (p.baseValue ?? p.baseCost) != null)
    .sort((a, b) => (b.baseValue ?? b.baseCost)! - (a.baseValue ?? a.baseCost)!)
    .slice(0, TOP_POSITIONS);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Overview <span className="font-normal text-muted">· {owner ?? "Together"}</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            The book, the markets and the week&rsquo;s insights ·{" "}
            <span title={pricesFetchedAt?.toLocaleString() ?? marketsUpdated?.toLocaleString() ?? undefined}>
              prices updated {fmtAgo(pricesFetchedAt ?? marketsUpdated)}
            </span>
          </p>
        </div>
        <RefreshMarketsButton />
      </header>

      <div className="mb-6">
        <InvestorSwitcher basePath="/" selected={owner} extraParams={{ period }} />
      </div>

      {warnings.length > 0 && (
        <div className="mb-4 space-y-1 rounded-xl border border-line bg-surface-raised p-3 text-sm text-muted">
          {warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      <section aria-labelledby="portfolio-heading" className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2
            id="portfolio-heading"
            className="text-sm font-semibold uppercase tracking-wide text-muted"
          >
            Portfolio
          </h2>
          <Link href="/portfolio" className="text-xs text-muted hover:text-foreground">
            Full portfolio →
          </Link>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card
            label={`Invested (${base}, incl. fees)`}
            value={fmtMoney(totals.invested, base)}
            sub={`${totals.positions} position${totals.positions === 1 ? "" : "s"}`}
          />
          <Card label={`Market value (${base})`} value={fmtMoney(totals.marketValue, base)} />
          <Card
            label="Unrealized P&L"
            value={fmtMoney(totals.unrealizedPnl, base)}
            sub={fmtPct(totals.unrealizedPnlPct)}
            color={pnlColor(totals.unrealizedPnl)}
          />
          <Card
            label="Realized P&L"
            value={fmtMoney(totals.realizedTotal, base)}
            sub="booked from sells"
            color={pnlColor(totals.realizedTotal)}
          />
        </div>

        {hasHoldings ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Largest positions
              </h3>
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {largest.map((p) => (
                  <li key={p.assetId}>
                    <Link
                      href={assetHref(p.assetId)}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-raised"
                    >
                      <span className="min-w-0">
                        <span className="font-medium">{p.symbol}</span>
                        <span className="ml-2 text-xs text-muted">{p.marketLabel}</span>
                        <span className="ml-2 text-xs text-muted">{fmtUnits(p.qty)} units</span>
                      </span>
                      <span className="flex shrink-0 items-baseline gap-3">
                        <span className="text-xs tabular-nums text-muted">
                          {fmtWeight(p.weightPct)}
                        </span>
                        <span className="w-24 text-right text-sm tabular-nums">
                          {fmtMoney(p.baseValue ?? p.baseCost, base)}
                        </span>
                        <span
                          className={`w-20 text-right text-sm tabular-nums ${pnlColor(p.baseUnrealizedPnl)}`}
                        >
                          {fmtPct(p.unrealizedPnlPct)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              {(best || worst) && (
                <p className="mt-2 text-xs text-muted">
                  {best && (
                    <>
                      Best: <Link href={assetHref(best.assetId)} className="hover:text-foreground">{best.symbol}</Link>{" "}
                      <span className={pnlColor(best.unrealizedPnlPct)}>{fmtPct(best.unrealizedPnlPct)}</span>
                    </>
                  )}
                  {best && worst && " · "}
                  {worst && (
                    <>
                      Worst: <Link href={assetHref(worst.assetId)} className="hover:text-foreground">{worst.symbol}</Link>{" "}
                      <span className={pnlColor(worst.unrealizedPnlPct)}>{fmtPct(worst.unrealizedPnlPct)}</span>
                    </>
                  )}
                </p>
              )}
            </div>
            {byAsset.length > 0 && (
              <div>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  Allocation
                </h3>
                <div className="rounded-xl border border-line p-4">
                  <AllocationDonut data={byAsset} currency={base} />
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
            No holdings yet.{" "}
            <Link href="/portfolio" className="text-accent underline-offset-2 hover:underline">
              Upload a broker statement or record a trade
            </Link>{" "}
            to see a portfolio here.
          </div>
        )}
      </section>

      <section aria-labelledby="markets-heading" className="mb-8">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2
            id="markets-heading"
            className="text-sm font-semibold uppercase tracking-wide text-muted"
          >
            Markets · {PERIOD_LABEL[period]}
          </h2>
          <div className="flex items-center gap-3">
            <PeriodTabs basePath="/" selected={period} extraParams={{ owner: owner ?? undefined }} />
            <Link href="/markets" className="text-xs text-muted hover:text-foreground">
              All markets →
            </Link>
          </div>
        </div>

        {marketViews.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
            No market data yet. Run{" "}
            <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs">
              npm run market:backfill
            </code>{" "}
            to seed the catalogue and pull a year of daily prices.
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {marketViews.map((view) => (
                <MarketCard key={view.market} view={view} period={period} />
              ))}
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <MoversList title={`Top gainers · ${PERIOD_LABEL[period]}`} movers={movers.gainers} />
              <MoversList title={`Top losers · ${PERIOD_LABEL[period]}`} movers={movers.losers} />
              <MoversList
                title={`Largest absolute moves · ${PERIOD_LABEL[period]}`}
                movers={movers.biggestAbsolute}
              />
            </div>
          </>
        )}
      </section>

      <div className="grid gap-8 lg:grid-cols-3">
        <section aria-labelledby="insights-heading" className="lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
            <h2
              id="insights-heading"
              className="text-sm font-semibold uppercase tracking-wide text-muted"
            >
              AI executive summary · week of {digest.weekStart}
            </h2>
            {digest.backend && <span className="text-xs text-muted">{digest.backend}</span>}
          </div>
          <InsightDigest digest={digest} />
        </section>

        <section aria-labelledby="news-heading">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="news-heading" className="text-sm font-semibold uppercase tracking-wide text-muted">
              Latest headlines
            </h2>
            <Link href="/news" className="text-xs text-muted hover:text-foreground">
              All news →
            </Link>
          </div>
          <NewsList items={news} />
        </section>
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${color ?? ""}`}>{value}</div>
      {sub && <div className={`text-xs tabular-nums ${color ?? "text-muted"}`}>{sub}</div>}
    </div>
  );
}
