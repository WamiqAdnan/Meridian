/**
 * What the market pages actually render.
 *
 * Assembles assets, quotes, daily bars and computed performance into one shape,
 * so a page never has to know that performance comes from bars while the live
 * price comes from a quote. Server-side only — it reads the database.
 *
 * The engines stay pure; this is the seam where they meet stored data.
 */
import { computePerformance, topMovers, type AssetPerformance, type Period } from "./performance";
import {
  daysAgo,
  daysBefore,
  getAsset,
  listAssetsWithQuotes,
  loadBars,
  type AssetWithQuote,
} from "./store";
import { fxTableFromAssets, type FxTable } from "./currency";
import { MARKET_META, isNotional, type BarData, type Market } from "./types";

/** An asset with everything a row or card needs. */
export interface AssetView extends AssetWithQuote {
  performance: AssetPerformance;
  /** Closes for the sparkline, oldest-first. Trimmed to a drawable length. */
  spark: number[];
}

export interface MarketView {
  market: Market;
  label: string;
  blurb: string;
  /** The asset that represents this market on the overview, if it has one. */
  headline: AssetView | null;
  assets: AssetView[];
  /** Median move across the market's benchmark assets — a breadth read. */
  medianChangePct: Record<Period, number | null>;
  /** How many of the market's assets rose over the window. */
  advancers: number;
  decliners: number;
}

/** How much history to load. A year covers every window the UI offers. */
const HISTORY_DAYS = 400;
const SPARK_POINTS = 30;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Load every tracked asset with its performance, plus the FX table.
 *
 * One pass over the database for all markets — cheaper than per-market queries
 * and it is what makes cross-market movers possible.
 */
export async function loadAssetViews(
  options: { market?: Market; asOf?: string } = {},
): Promise<{
  assets: AssetView[];
  fx: FxTable;
}> {
  const rows = await listAssetsWithQuotes();
  // `asOf` reads the market as it stood at the close of a past day: the bar
  // window shifts back with it, and `computePerformance` anchors on the last bar
  // in the series, so every period reported is that day's rather than today's.
  const bars = await loadBars(
    rows.map((a) => a.id),
    options.asOf ? daysBefore(options.asOf, HISTORY_DAYS) : daysAgo(HISTORY_DAYS),
    options.asOf,
  );

  const assets: AssetView[] = rows.map((a) => {
    const series = bars.get(a.id) ?? [];
    return {
      ...a,
      performance: computePerformance(a.id, series),
      spark: series.slice(-SPARK_POINTS).map((b) => b.close),
    };
  });

  // The FX table is built from every asset regardless of the market filter —
  // converting a PSX holding to USD needs the forex market loaded either way.
  const fx = fxTableFromAssets(rows);
  return {
    assets: options.market ? assets.filter((a) => a.market === options.market) : assets,
    fx,
  };
}

/**
 * How much history one asset's own page loads. Two years, matching the backfill's
 * default range — more than the longest window the UI reports, which is the rule
 * the whole market layer follows.
 */
const DETAIL_DAYS = 800;

export interface AssetDetail {
  asset: AssetView;
  /**
   * The whole loaded series, oldest-first.
   *
   * Returned alongside the asset rather than folded into it: `AssetView.spark` is
   * thirty points trimmed for a sparkline, and a chart with axes needs the real
   * series. One is not a substitute for the other.
   */
  bars: BarData[];
}

/**
 * One asset in full, or null if nothing by that id is tracked.
 *
 * Inactive assets resolve, deliberately — an asset switched off still has a page,
 * a history and a position behind it, and a dead link from the ledger would be
 * worse than a page that says it is no longer tracked.
 */
export async function loadAssetDetail(
  id: string,
  days = DETAIL_DAYS,
): Promise<AssetDetail | null> {
  const row = await getAsset(id);
  if (!row) return null;

  const bars = (await loadBars([id], daysAgo(days))).get(id) ?? [];
  return {
    asset: {
      ...row,
      performance: computePerformance(id, bars),
      spark: bars.slice(-SPARK_POINTS).map((b) => b.close),
    },
    bars,
  };
}

/**
 * Group loaded assets into per-market summaries, in display order.
 *
 * `all` is the unfiltered set, used only to resolve headline assets: US Stocks is
 * headlined by the S&P 500, which lives in the `indices` market, so a lookup
 * scoped to the market's own assets would never find it.
 */
export function buildMarketViews(
  assets: AssetView[],
  period: Period = "week",
  all: AssetView[] = assets,
): MarketView[] {
  const byMarket = new Map<Market, AssetView[]>();
  for (const a of assets) {
    const bucket = byMarket.get(a.market);
    if (bucket) bucket.push(a);
    else byMarket.set(a.market, [a]);
  }
  const byId = new Map(all.map((a) => [a.id, a]));

  const views: MarketView[] = [];
  for (const [market, meta] of Object.entries(MARKET_META) as [Market, typeof MARKET_META[Market]][]) {
    const marketAssets = byMarket.get(market);
    if (!marketAssets || marketAssets.length === 0) continue;

    // Breadth counts things that actually trade. Four PSX index levels all move
    // together, so "0 up, 4 down" says nothing; the seventeen equities beneath
    // them do. Markets that are entirely notional (indices, yields) fall back to
    // their own members.
    const tradable = marketAssets.filter((a) => !isNotional(a.kind));
    const basis = tradable.length > 0 ? tradable : marketAssets;

    const medians = {} as Record<Period, number | null>;
    for (const p of ["day", "week", "month", "quarter", "ytd", "year"] as Period[]) {
      medians[p] = median(
        basis.map((a) => a.performance.periods[p]?.changePct).filter((v): v is number => v != null),
      );
    }

    const moves = basis
      .map((a) => a.performance.periods[period]?.changePct)
      .filter((v): v is number => v != null);

    views.push({
      market,
      label: meta.label,
      blurb: meta.blurb,
      headline: meta.headline ? (byId.get(meta.headline) ?? null) : null,
      assets: marketAssets,
      medianChangePct: medians,
      advancers: moves.filter((m) => m > 0).length,
      decliners: moves.filter((m) => m < 0).length,
    });
  }

  return views;
}

/**
 * A market's move over one window, together with the unit it is to be read in.
 *
 * The number and its unit are returned as one value rather than assembled at each
 * call site, because the moment the headline has no data for the window they stop
 * coming from the same place. The move then falls back to the median, which is
 * computed across the market's own basis — and a card that went on taking the unit
 * from the headline asked for a move in a unit that median was never in. On bonds
 * the two disagree outright: the basis is six dollar-priced ETFs while the
 * headline is a yield quoted in basis points, so the card asked `fmtMove` for
 * basis points, had no absolute change to give it, and printed a dash over a
 * median it had just computed.
 */
export interface MarketMove {
  changePct: number | null;
  /** The absolute move in `currency` — only a headline asset supplies one. */
  change: number | null;
  /** What `change` is denominated in, and what tells a formatter to use bps. */
  currency: string;
  /** True when this is the median across the market rather than the headline's move. */
  median: boolean;
}

/**
 * The unit a median carries.
 *
 * A median is a median of `changePct`, which is a plain percentage for every asset
 * whatever that asset is priced in. Deliberately not the headline's currency, and
 * deliberately not "PCT": both would send `fmtMove` down its basis-points branch.
 */
const MEDIAN_UNIT = "%";

/**
 * The market's own move over a window.
 *
 * Prefers the headline asset (the S&P for stocks, BTC for crypto) and falls back
 * to the median across the market, which is the honest answer for a market like
 * commodities where no single asset represents the whole.
 */
export function marketMove(view: MarketView, period: Period): MarketMove {
  const headline = view.headline;
  const own = headline && headline.performance.periods[period];
  if (headline && own) {
    return { changePct: own.changePct, change: own.change, currency: headline.currency, median: false };
  }
  return {
    changePct: view.medianChangePct[period],
    change: null,
    currency: MEDIAN_UNIT,
    median: true,
  };
}

/** Just the percentage, for callers with nothing to format — insights, mostly. */
export function marketChange(view: MarketView, period: Period): number | null {
  return marketMove(view, period).changePct;
}

/** Cross-market gainers and losers over one window. */
export function crossMarketMovers(assets: AssetView[], period: Period, limit = 6) {
  return topMovers(assets, (a) => a.performance, period, limit);
}

/** The freshest quote timestamp across a set of assets. */
export function newestFetch(assets: AssetView[]): Date | null {
  let newest: Date | null = null;
  for (const a of assets) {
    if (a.fetchedAt && (!newest || a.fetchedAt > newest)) newest = a.fetchedAt;
  }
  return newest;
}
