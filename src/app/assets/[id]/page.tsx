import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PERIODS, PERIOD_LABEL, type Period } from "@/lib/markets/performance";
import { chartWindow, seriesExtent } from "@/lib/markets/chart";
import { loadAssetDetail } from "@/lib/markets/view";
import { refreshIfStale } from "@/lib/markets/refresh";
import {
  MARKET_META,
  assetId as canonicalAssetId,
  isNotional,
  parseAssetId,
} from "@/lib/markets/types";
import { ingestIfStale } from "@/lib/news/ingest";
import { newsForAsset } from "@/lib/news/store";
import { loadPortfolio } from "@/lib/portfolio-view";
import { DEFAULT_BASE_CURRENCY } from "@/lib/portfolio";
import { toOwnerFilter } from "@/lib/investors";
import { assetHref, marketHref } from "@/lib/routes";
import { fmtAgo, fmtCompact, fmtMoney, fmtMove, fmtPct, fmtPrice, fmtUnits, pnlColor } from "@/lib/format";
import Change from "@/components/markets/Change";
import PeriodTabs from "@/components/markets/PeriodTabs";
import PriceChart from "@/components/markets/PriceChart";
import RefreshMarketsButton from "@/components/markets/RefreshMarketsButton";
import InvestorSwitcher from "@/components/InvestorSwitcher";
import NewsList from "@/components/news/NewsList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `decodeURIComponent` throws on a lone `%`. A malformed URL is a 404, not a 500.
 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Read the canonical asset id out of the URL segment.
 *
 * **The decode is load-bearing, not defensive padding.** In Next 16 the page
 * component receives `params.id` still percent-encoded — `psx%3AFFC` — while
 * `generateMetadata` receives it decoded. An asset id carries a colon, so a page
 * that trusted its own param 404'd every asset in the app while the browser tab
 * title resolved perfectly. Decode first, then parse.
 *
 * `/assets/psx:luck` and `/assets/psx:LUCK` are the same asset — the id format
 * upper-cases the symbol — so a hand-typed lower-case link resolves rather than
 * 404ing. Anything that is not `{market}:{symbol}` is not an asset id at all.
 */
function toAssetId(raw: string): string | null {
  const parsed = parseAssetId(safeDecode(raw));
  return parsed ? canonicalAssetId(parsed.market, parsed.symbol) : null;
}

function toPeriod(v: unknown): Period {
  return typeof v === "string" && (PERIODS as readonly string[]).includes(v) ? (v as Period) : "month";
}

/**
 * `generateMetadata` resolves before the page and outside its error boundary, so
 * anything it throws is an unstyled 500 rather than the app's error page —
 * measured by pointing DATABASE_URL at a file that does not exist. It reads the
 * database, so it swallows its own failure and lets the page below raise the same
 * problem somewhere a reader can see it.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const id = toAssetId((await params).id);
  const detail = id ? await loadAssetDetail(id).catch(() => null) : null;
  if (!detail) return { title: "Asset" };
  const { asset } = detail;
  return {
    title: `${asset.symbol} · ${asset.name}`,
    description: `${asset.name} (${asset.symbol}) in ${MARKET_META[asset.market].label}: price, performance, the position held, and the headlines matched to it.`,
  };
}

/**
 * One asset, whatever market it is in.
 *
 * The page the whole app was missing: movers, holdings, news chips and insight
 * movements all name a symbol, and until now every one of them could only link to
 * the *market* the symbol sits in. It is deliberately market-agnostic — a PSX
 * equity, a Treasury yield and a coin all render through the same component,
 * because nothing below the view layer cares which market an asset came from.
 *
 * The chart and the percentage above it are computed from the same `windowStart`,
 * so the line always covers the period the number claims.
 */
export default async function AssetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string; owner?: string }>;
}) {
  const id = toAssetId((await params).id);
  if (!id) notFound();

  const query = await searchParams;
  const period = toPeriod(query.period);
  const owner = toOwnerFilter(query.owner);
  const base = DEFAULT_BASE_CURRENCY;

  const parsed = parseAssetId(id)!;
  // Same cadence as the market page: prices and news refresh themselves when
  // stale, and both swallow their own failures.
  await refreshIfStale({ market: parsed.market });
  await ingestIfStale({ market: parsed.market });

  const detail = await loadAssetDetail(id);
  if (!detail) notFound();
  const { asset, bars } = detail;
  const meta = MARKET_META[asset.market];

  const [portfolio, news] = await Promise.all([
    loadPortfolio({ owner, baseCurrency: base }),
    newsForAsset(id, 8),
  ]);
  const position = portfolio.positions.find((p) => p.assetId === id) ?? null;
  const realized = portfolio.realized.find((r) => r.assetId === id) ?? null;

  const chart = chartWindow(bars, period);
  const drawn = chart.bars;
  const extent = seriesExtent(drawn);
  const selected = asset.performance.periods[period];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-3 text-sm text-muted">
        <Link href="/markets" className="hover:text-foreground">
          Markets
        </Link>
        <span aria-hidden> / </span>
        <Link href={marketHref(asset.market)} className="hover:text-foreground">
          {meta.label}
        </Link>
        <span aria-hidden> / </span>
        <span className="text-foreground">{asset.symbol}</span>
      </nav>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">
            {asset.symbol}
            {/* A ledger-derived asset has no name but its own ticker — `syncLedgerAssets`
                has nothing better to call it — and "FFC · FFC" reads as a bug. */}
            {asset.name !== asset.symbol && (
              <span className="font-normal text-muted"> · {asset.name}</span>
            )}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {meta.label} · {asset.kind.replace("_", " ")} ·{" "}
            {isNotional(asset.kind) ? "a level, not a price" : `quoted in ${asset.currency}`} ·{" "}
            <span title={asset.fetchedAt?.toLocaleString() ?? undefined}>
              updated {fmtAgo(asset.fetchedAt)}
            </span>
          </p>
        </div>
        <RefreshMarketsButton market={asset.market} />
      </header>

      <section className="mb-6 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span className="text-3xl font-bold tabular-nums">
          {fmtPrice(asset.price, asset.currency)}
        </span>
        <span className="flex items-baseline gap-1.5">
          <Change
            changePct={asset.changePct}
            change={asset.change}
            currency={asset.currency}
            className="text-base font-medium"
          />
          <span className="text-xs text-muted">today</span>
        </span>
        <span className="flex items-baseline gap-1.5">
          <Change
            changePct={selected?.changePct}
            change={selected?.change}
            currency={asset.currency}
            className="text-base font-medium"
          />
          <span className="text-xs text-muted">over {PERIOD_LABEL[period]}</span>
        </span>
        {asset.volume != null && (
          <span className="text-xs text-muted">volume {fmtCompact(asset.volume)}</span>
        )}
      </section>

      <div className="mb-4">
        <PeriodTabs basePath={assetHref(id)} selected={period} extraParams={{ owner: owner ?? undefined }} />
      </div>

      <section aria-labelledby="chart-heading" className="mb-8">
        <h2 id="chart-heading" className="sr-only">
          Price history
        </h2>
        <div className="rounded-xl border border-line bg-surface p-4">
          <PriceChart bars={drawn} currency={asset.currency} label={asset.name} />
          {extent && (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 text-xs sm:grid-cols-5">
                <Stat label="Window open" value={fmtPrice(extent.first, asset.currency)} />
                <Stat label="Window close" value={fmtPrice(extent.last, asset.currency)} />
                <Stat label="High" value={fmtPrice(extent.high, asset.currency)} />
                <Stat label="Low" value={fmtPrice(extent.low, asset.currency)} />
                {/* The line is coloured by its own direction, so that direction is
                    given as a number too. A colour a reader cannot check against
                    anything is the weakest kind of claim on the page. */}
                <Stat
                  label="Across the line"
                  value={fmtPct(extent.changePct)}
                  color={pnlColor(extent.changePct)}
                />
              </dl>
              {/* Say what was drawn, not what was asked for. */}
              <p className="mt-3 text-xs text-muted">
                {extent.sessions} daily closes, {extent.from} to {extent.to} · axis in{" "}
                {asset.currency} ·{" "}
                {chart.exact
                  ? `exactly the ${PERIOD_LABEL[period]} window, measured from its reference close`
                  : period === "day"
                    ? "1D is a single session, so recent sessions are shown instead"
                    : `not enough stored history for the ${PERIOD_LABEL[period]} window, so recent sessions are shown`}
              </p>
            </>
          )}
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-8">
          <section aria-labelledby="performance-heading">
            <h2
              id="performance-heading"
              className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted"
            >
              Performance
            </h2>
            <div className="overflow-hidden rounded-xl border border-line">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  Change over each window, with the sessions it was measured between
                </caption>
                <thead className="bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">Window</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Change</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">From</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">To</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Measured</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {PERIODS.map((p) => {
                    const change = asset.performance.periods[p];
                    return (
                      <tr key={p} className={p === period ? "bg-surface-raised/60" : undefined}>
                        <th scope="row" className="px-3 py-2 text-left font-normal">
                          {PERIOD_LABEL[p]}
                        </th>
                        <td className="px-3 py-2 text-right">
                          <Change
                            changePct={change?.changePct}
                            change={change?.change}
                            currency={asset.currency}
                            className="font-medium"
                          />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">
                          {change ? fmtPrice(change.from, asset.currency) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">
                          {change ? fmtPrice(change.to, asset.currency) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right text-xs tabular-nums text-muted">
                          {change ? `${change.fromDate} → ${change.toDate}` : "insufficient data"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* The one disagreement on this page that is not a bug. */}
            <p className="mt-2 text-xs text-muted">
              Windowed changes come from daily closes; the price above comes from the live quote.
              They legitimately differ during a session.
            </p>
          </section>

          {news.length > 0 && (
            <section aria-labelledby="asset-news">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2
                  id="asset-news"
                  className="text-sm font-semibold uppercase tracking-wide text-muted"
                >
                  In the news
                </h2>
                <Link
                  href={`/news?market=${asset.market}`}
                  className="text-xs text-muted hover:text-foreground"
                >
                  All {meta.label.toLowerCase()} news →
                </Link>
              </div>
              <NewsList items={news} />
            </section>
          )}
        </div>

        <aside className="space-y-6">
          <section aria-labelledby="position-heading">
            <h2
              id="position-heading"
              className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted"
            >
              Your position
            </h2>
            <div className="mb-3">
              <InvestorSwitcher basePath={assetHref(id)} selected={owner} extraParams={{ period }} />
            </div>
            {position ? (
              <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface text-sm">
                <Row label="Quantity" value={fmtUnits(position.qty)} />
                <Row
                  label="Average cost"
                  value={position.currency ? fmtPrice(position.avgCostInclFees, position.currency) : "—"}
                  note="including fees"
                />
                <Row
                  label={`Market value (${base})`}
                  value={
                    position.baseValue != null || position.baseCost != null
                      ? fmtMoney(position.baseValue ?? position.baseCost, base)
                      : "—"
                  }
                />
                <Row
                  label="Unrealized P&L"
                  value={
                    position.baseUnrealizedPnl != null
                      ? fmtMoney(position.baseUnrealizedPnl, base)
                      : "—"
                  }
                  note={fmtPct(position.unrealizedPnlPct)}
                  color={pnlColor(position.baseUnrealizedPnl)}
                />
                <Row
                  label="Today"
                  value={
                    position.currency ? fmtMove(position.dayChangePct, null, position.currency) : "—"
                  }
                  color={pnlColor(position.dayChangePct)}
                />
                {realized && (
                  <Row
                    label="Realized P&L"
                    value={
                      realized.currency
                        ? fmtMoney(realized.amount, realized.currency)
                        : realized.amount.toFixed(2)
                    }
                    note="booked from sells, in its own currency"
                    color={pnlColor(realized.amount)}
                  />
                )}
              </dl>
            ) : (
              <p className="rounded-xl border border-dashed border-line px-3 py-5 text-center text-sm text-muted">
                {isNotional(asset.kind)
                  ? "A level, not an instrument — there is nothing here to hold."
                  : "Not held in this view."}{" "}
                <Link href="/portfolio" className="text-accent underline-offset-2 hover:underline">
                  Record a trade
                </Link>
                .
              </p>
            )}
          </section>

          <section aria-labelledby="provenance-heading">
            <h2
              id="provenance-heading"
              className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted"
            >
              Where this comes from
            </h2>
            <dl className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface text-sm">
              <Row label="Asset id" value={asset.id} />
              <Row label="Priced by" value={asset.quoteSource ?? asset.source} note={`as ${asset.sourceSymbol}`} />
              <Row label="Daily closes stored" value={String(bars.length)} />
              <Row
                label="Tracked because"
                value={asset.benchmark ? "seeded in the catalogue" : "the ledger refers to it"}
              />
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className={`mt-0.5 font-medium tabular-nums ${color ?? ""}`}>{value}</dd>
    </div>
  );
}

function Row({
  label,
  value,
  note,
  color,
}: {
  label: string;
  value: string;
  note?: string;
  color?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-2">
      <dt className="text-muted">{label}</dt>
      <dd className={`text-right tabular-nums ${color ?? ""}`}>
        <div className="font-medium">{value}</div>
        {note && <div className="text-xs text-muted">{note}</div>}
      </dd>
    </div>
  );
}
