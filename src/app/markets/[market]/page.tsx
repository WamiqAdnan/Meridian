import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PERIOD_LABEL, PERIODS, topMovers, type Period } from "@/lib/markets/performance";
import { buildMarketViews, loadAssetViews, marketChange, newestFetch } from "@/lib/markets/view";
import { refreshIfStale } from "@/lib/markets/refresh";
import { MARKET_META, MARKETS, isMarket, type Market } from "@/lib/markets/types";
import { fmtAgo, fmtPrice } from "@/lib/format";
import AssetTable from "@/components/markets/AssetTable";
import Change from "@/components/markets/Change";
import MoversList from "@/components/markets/MoversList";
import PeriodTabs from "@/components/markets/PeriodTabs";
import RefreshMarketsButton from "@/components/markets/RefreshMarketsButton";
import NewsList from "@/components/news/NewsList";
import { ingestIfStale } from "@/lib/news/ingest";
import { loadNewsFeed } from "@/lib/news/view";
import InsightCard from "@/components/insights/InsightCard";
import GenerateInsightButton from "@/components/insights/GenerateInsightButton";
import { loadInsightPanel } from "@/lib/insights/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pre-render the known markets; the set is fixed and small. */
export function generateStaticParams() {
  return MARKETS.map((market) => ({ market }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ market: string }>;
}): Promise<Metadata> {
  const { market } = await params;
  if (!isMarket(market)) return { title: "Market" };
  return { title: MARKET_META[market].label, description: MARKET_META[market].blurb };
}

function toPeriod(v: unknown): Period {
  return typeof v === "string" && (PERIODS as readonly string[]).includes(v) ? (v as Period) : "week";
}

/** One market in full: its own summary, its movers, and every asset in it. */
export default async function MarketPage({
  params,
  searchParams,
}: {
  params: Promise<{ market: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { market } = await params;
  if (!isMarket(market)) notFound();
  const period = toPeriod((await searchParams).period);

  await refreshIfStale({ market: market as Market });
  // News is fetched on its own cadence and swallows its own failures, so a dead
  // feed costs this page nothing.
  await ingestIfStale({ market: market as Market });

  // Load everything, then narrow: this market's headline may live elsewhere
  // (US Stocks is headlined by the S&P, which sits in `indices`).
  const { assets: all } = await loadAssetViews();
  const assets = all.filter((a) => a.market === market);
  const [view] = buildMarketViews(assets, period, all);
  const meta = MARKET_META[market];
  const movers = topMovers(assets, (a) => a.performance, period, 5);
  const updated = newestFetch(assets);
  const news = await loadNewsFeed({ market: market as Market, limit: 8 });
  // Read-only, unlike prices and news above: generating an insight is a model
  // call that can run for minutes, so it never happens on a render.
  const insight = await loadInsightPanel(market as Market);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-muted">
        <Link href="/markets" className="hover:text-foreground">
          Markets
        </Link>
        <span aria-hidden> / </span>
        <span className="text-foreground">{meta.label}</span>
      </nav>

      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{meta.label}</h1>
          <p className="mt-1 text-sm text-muted">
            {meta.blurb} · {assets.length} tracked ·{" "}
            <span title={updated?.toLocaleString() ?? undefined}>updated {fmtAgo(updated)}</span>
          </p>
        </div>
        <RefreshMarketsButton market={market} />
      </header>

      {view?.headline && (
        <section className="mb-6 rounded-xl border border-line bg-surface p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted">
            {view.headline.name}
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-bold tabular-nums">
              {fmtPrice(view.headline.price, view.headline.currency)}
            </span>
            <Change
              changePct={marketChange(view, period)}
              change={view.headline.performance.periods[period]?.change}
              currency={view.headline.currency}
              className="text-base font-medium"
            />
            <span className="text-xs text-muted">over {PERIOD_LABEL[period]}</span>
          </div>
        </section>
      )}

      <div className="mb-4">
        <PeriodTabs basePath={`/markets/${market}`} selected={period} />
      </div>

      {assets.length > 0 && (
        <section aria-labelledby="market-movers" className="mb-8">
          <h2 id="market-movers" className="sr-only">
            Movers in {meta.label}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <MoversList title={`Top gainers · ${PERIOD_LABEL[period]}`} movers={movers.gainers} />
            <MoversList title={`Top losers · ${PERIOD_LABEL[period]}`} movers={movers.losers} />
          </div>
        </section>
      )}

      <section aria-labelledby="insight-heading" className="mb-8">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2
            id="insight-heading"
            className="text-sm font-semibold uppercase tracking-wide text-muted"
          >
            AI insight
          </h2>
          <GenerateInsightButton
            market={market}
            backend={insight.backend}
            hasInsight={insight.insight != null}
          />
        </div>
        {insight.insight ? (
          <InsightCard insight={insight.insight} stale={insight.stale} market={market} />
        ) : (
          <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-sm text-muted">
            No insight for {meta.label.toLowerCase()} yet. Generating one takes this
            week’s unusual moves — assets that did something far from their own norm — and
            the headlines retrieved against them, and says what those headlines suggest,
            keeping what the price data says apart from what a model inferred. A week in
            which nothing moved unusually has nothing to explain, and is skipped.
          </p>
        )}
      </section>

      {news.length > 0 && (
        <section aria-labelledby="market-news" className="mb-8">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2
              id="market-news"
              className="text-sm font-semibold uppercase tracking-wide text-muted"
            >
              In the news
            </h2>
            <Link href={`/news?market=${market}`} className="text-xs text-muted hover:text-foreground">
              All {meta.label.toLowerCase()} news →
            </Link>
          </div>
          <NewsList items={news} />
        </section>
      )}

      <section aria-labelledby="all-assets">
        <h2 id="all-assets" className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          All {meta.label.toLowerCase()} assets
        </h2>
        <AssetTable assets={assets} />
      </section>
    </div>
  );
}
