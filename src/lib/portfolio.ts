/**
 * What the book is worth, across every market at once.
 *
 * Pure arithmetic — no Prisma, no fetch. Give it ledger rows, priced assets, an
 * FX table and a base currency, and it answers "what do I own, what is it worth,
 * and what moved". `portfolio-view.ts` is the seam that feeds it from the
 * database; this file is exercised offline by `npm run check:portfolio`.
 *
 * Three rules hold it together:
 *
 *   - Positions are keyed by `assetId`, never by ticker. PSX's LUCK and a US LUCK
 *     are different instruments and must never merge into one row.
 *   - Every position keeps its native currency alongside the base-currency
 *     figure. A US holding is $-denominated and saying so is not optional.
 *   - Anything that cannot be converted is reported, never dropped and never
 *     guessed. A total that quietly omits a position is worse than one that says
 *     which position it could not include.
 */
import { computeHoldings, type Holding, type LedgerTrade } from "./holdings";
import { resolveAssetId } from "./ledger";
import { convert, isMoney, type FxTable } from "./markets/currency";
import type { AssetPerformance, Period } from "./markets/performance";
import { MARKET_META, parseAssetId, type AssetKind, type Market } from "./markets/types";

/** The currencies the app will total a portfolio in. */
export const BASE_CURRENCIES = ["PKR", "USD"] as const;
export type BaseCurrency = (typeof BASE_CURRENCIES)[number];
export const DEFAULT_BASE_CURRENCY: BaseCurrency = "PKR";

export function isBaseCurrency(v: unknown): v is BaseCurrency {
  return typeof v === "string" && (BASE_CURRENCIES as readonly string[]).includes(v);
}

export function toBaseCurrency(v: unknown): BaseCurrency {
  return isBaseCurrency(v) ? v : DEFAULT_BASE_CURRENCY;
}

/**
 * The currency a market implies when the asset itself is unknown.
 *
 * Only PSX qualifies: it settles in rupees and nothing else, so a `psx:` holding
 * whose `Asset` row is missing is still safely PKR. Every other market spans
 * currencies, and answering "probably USD" there would put a made-up number into
 * a total. Those are left `null` and reported instead.
 */
function impliedCurrency(market: Market): string | null {
  return market === "psx" ? "PKR" : null;
}

/** A ledger row, plus the soft asset reference that says which market it is in. */
export interface PortfolioTrade extends LedgerTrade {
  assetId?: string | null;
}

/** An asset as the portfolio needs it: identity, quote currency, live price. */
export interface PricedAsset {
  id: string;
  market: Market;
  symbol: string;
  name: string;
  kind: AssetKind;
  currency: string;
  price: number | null;
  /** Day move from the live quote, in percent. */
  changePct: number | null;
  /** Windowed moves from stored bars. Absent for an asset with no history. */
  performance?: AssetPerformance;
}

/** The windows the portfolio reports a P&L figure for. */
export const PNL_PERIODS = ["day", "week", "month"] as const;
export type PnlPeriod = (typeof PNL_PERIODS)[number];

export interface PortfolioPosition extends Holding {
  assetId: string;
  market: Market;
  marketLabel: string;
  symbol: string;
  name: string;
  kind: AssetKind;
  /** The currency this position is quoted and costed in, or null if unknown. */
  currency: string | null;

  /* ---- native currency ---- */
  price: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  dayChangePct: number | null;

  /* ---- base currency ---- */
  baseCost: number | null;
  baseValue: number | null;
  baseUnrealizedPnl: number | null;
  /** Share of the portfolio's base-currency market value, in percent. */
  weightPct: number | null;
  /**
   * Base-currency gain or loss over each window, from the asset's own price move
   * applied to the quantity held now. Null where the series cannot cover it.
   */
  periodPnl: Record<PnlPeriod, number | null>;
  /** The asset's own percentage move over each window. */
  periodChangePct: Record<PnlPeriod, number | null>;
}

/**
 * Realized P&L on one asset.
 *
 * Kept in both currencies on purpose: the native figure is what was actually
 * booked, and the base figure is the only one that can be added to another
 * asset's. A page that shows one without saying which is stating a number in an
 * unnamed currency.
 */
export interface RealizedEntry {
  assetId: string;
  symbol: string;
  currency: string | null;
  /** In the asset's own currency — what the sells actually booked. */
  amount: number;
  /** Converted to the base currency, or null where no rate was available. */
  baseAmount: number | null;
}

export interface AllocationSlice {
  key: string;
  label: string;
  value: number;
  weightPct: number;
}

export interface PortfolioTotals {
  baseCurrency: string;
  /** Cost basis including fees, in base currency. */
  invested: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  /** Realized P&L booked from sells, converted to base currency. */
  realizedTotal: number;
  positions: number;
  /** How many positions have a live price, and how many could be converted. */
  pricedCount: number;
  convertedCount: number;
  /** Base-currency P&L over each window, summed across convertible positions. */
  periodPnl: Record<PnlPeriod, number | null>;
}

export interface Portfolio {
  positions: PortfolioPosition[];
  totals: PortfolioTotals;
  /** Market value by market and by asset, both in base currency. */
  byMarket: AllocationSlice[];
  byAsset: AllocationSlice[];
  /** Best and worst by unrealized return, among positions that have a price. */
  best: PortfolioPosition | null;
  worst: PortfolioPosition | null;
  /** Realized P&L per asset, largest booked gain first. */
  realized: RealizedEntry[];
  warnings: string[];
}

const EMPTY_PERIODS: Record<PnlPeriod, number | null> = { day: null, week: null, month: null };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface BuildPortfolioOptions {
  baseCurrency?: string;
  /** Assets not in this list are still held — they just cannot be priced. */
  assets: PricedAsset[];
  fx: FxTable;
}

/**
 * Derive the whole portfolio from the ledger.
 *
 * `computeHoldings` does the position arithmetic unchanged; it is fed asset ids
 * in place of tickers so its `security` key is globally unique. Everything here
 * is the layer above: pricing each position, converting it, and describing the
 * shape of the book.
 */
export function buildPortfolio(
  trades: PortfolioTrade[],
  options: BuildPortfolioOptions,
): Portfolio {
  const base = options.baseCurrency ?? DEFAULT_BASE_CURRENCY;
  const byId = new Map(options.assets.map((a) => [a.id, a]));

  // Keying holdings by asset id is the whole reason a multi-market book works:
  // two markets may both list a "LUCK" and they must not blend into one row.
  const keyed = trades.map((t) => ({ ...t, security: resolveAssetId(t) }));
  const { holdings, realizedBySecurity, warnings } = computeHoldings(keyed);

  const unpriced: string[] = [];
  const unconverted: string[] = [];
  const unknown: string[] = [];

  const positions: PortfolioPosition[] = holdings.map((h) => {
    const assetId = h.security;
    const asset = byId.get(assetId);

    // An asset the catalogue has never heard of still shows up, at cost. The
    // alternative — hiding a position because we lack a price — loses money the
    // user actually owns.
    if (!asset) unknown.push(assetId);

    // The market is readable from the id itself, so an uncatalogued holding is
    // still filed under the right market rather than defaulting into PSX.
    const market = asset?.market ?? parseAssetId(assetId)?.market ?? "psx";
    const currency = asset?.currency ?? impliedCurrency(market);
    const price = asset?.price ?? null;
    if (asset && price == null) unpriced.push(asset.symbol);

    const marketValue = price != null ? price * h.qty : null;
    const unrealizedPnl = marketValue != null ? marketValue - h.totalCost : null;

    const baseCost = currency != null ? convert(h.totalCost, currency, base, options.fx) : null;
    const baseValue =
      marketValue != null && currency != null
        ? convert(marketValue, currency, base, options.fx)
        : null;
    if (baseCost == null) unconverted.push(asset?.symbol ?? assetId);

    const periodPnl = { ...EMPTY_PERIODS };
    const periodChangePct = { ...EMPTY_PERIODS };
    for (const p of PNL_PERIODS) {
      const window = asset?.performance?.periods[p as Period];
      if (!window) continue;
      periodChangePct[p] = window.changePct;
      // The move on what is held now — not a time-weighted return. A position
      // opened mid-window is credited with the whole window's move, which is why
      // this is labelled "market movement" in the UI rather than "your return".
      const native = (window.to - window.from) * h.qty;
      periodPnl[p] = currency != null ? convert(native, currency, base, options.fx) : null;
    }

    return {
      ...h,
      assetId,
      market,
      marketLabel: MARKET_META[market]?.label ?? market,
      symbol: asset?.symbol ?? assetId.split(":")[1] ?? assetId,
      name: asset?.name ?? assetId,
      kind: asset?.kind ?? "stock",
      currency,
      price,
      marketValue,
      unrealizedPnl,
      unrealizedPnlPct:
        unrealizedPnl != null && h.totalCost > 0 ? (unrealizedPnl / h.totalCost) * 100 : null,
      dayChangePct: asset?.changePct ?? null,
      baseCost,
      baseValue,
      baseUnrealizedPnl: baseValue != null && baseCost != null ? baseValue - baseCost : null,
      weightPct: null, // filled below, once the denominator is known
      periodPnl,
      periodChangePct,
    };
  });

  /* --------------------------------------------------------------- totals */

  // Cost stands in for value on an unpriced position so the invested and value
  // columns describe the same set of positions. A total that silently covers
  // fewer positions than the one beside it is how a portfolio appears to shrink.
  const invested = positions.reduce((s, p) => s + (p.baseCost ?? 0), 0);
  const marketValue = positions.reduce((s, p) => s + (p.baseValue ?? p.baseCost ?? 0), 0);
  const unrealizedPnl = marketValue - invested;

  for (const p of positions) {
    const value = p.baseValue ?? p.baseCost;
    p.weightPct = value != null && marketValue > 0 ? (value / marketValue) * 100 : null;
  }

  const periodPnl = { ...EMPTY_PERIODS };
  for (const period of PNL_PERIODS) {
    const contributions = positions
      .map((p) => p.periodPnl[period])
      .filter((v): v is number => v != null);
    // No position with enough history means "insufficient data", not "flat".
    periodPnl[period] = contributions.length > 0 ? round2(contributions.reduce((a, b) => a + b, 0)) : null;
  }

  let realizedTotal = 0;
  const realized: RealizedEntry[] = [];
  for (const [assetId, amount] of Object.entries(realizedBySecurity)) {
    const asset = byId.get(assetId);
    const currency =
      asset?.currency ?? impliedCurrency(parseAssetId(assetId)?.market ?? "psx");
    const baseAmount = currency != null ? convert(amount, currency, base, options.fx) : null;
    realized.push({
      assetId,
      symbol: asset?.symbol ?? assetId.split(":")[1] ?? assetId,
      currency,
      amount,
      baseAmount,
    });
    if (baseAmount == null) {
      unconverted.push(`realized P&L on ${assetId}`);
      continue;
    }
    realizedTotal += baseAmount;
  }
  realized.sort((a, b) => (b.baseAmount ?? b.amount) - (a.baseAmount ?? a.amount));

  /* ----------------------------------------------------------- allocation */

  const marketTotals = new Map<Market, number>();
  for (const p of positions) {
    const value = p.baseValue ?? p.baseCost;
    if (value == null) continue;
    marketTotals.set(p.market, (marketTotals.get(p.market) ?? 0) + value);
  }

  const byMarket: AllocationSlice[] = [...marketTotals.entries()]
    .map(([market, value]) => ({
      key: market,
      label: MARKET_META[market]?.label ?? market,
      value: round2(value),
      weightPct: marketValue > 0 ? (value / marketValue) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  const byAsset: AllocationSlice[] = positions
    .filter((p) => (p.baseValue ?? p.baseCost) != null)
    .map((p) => ({
      key: p.assetId,
      label: p.symbol,
      value: round2((p.baseValue ?? p.baseCost)!),
      weightPct: p.weightPct ?? 0,
    }))
    .sort((a, b) => b.value - a.value);

  /* -------------------------------------------------------- best / worst */

  const ranked = positions
    .filter((p) => p.unrealizedPnlPct != null)
    .sort((a, b) => b.unrealizedPnlPct! - a.unrealizedPnlPct!);

  /* ------------------------------------------------------------ warnings */

  const allWarnings = [...warnings];
  if (unknown.length > 0) {
    allWarnings.push(
      `${unknown.length} holding${unknown.length === 1 ? "" : "s"} not in the asset catalogue (${unknown.join(", ")}) — shown at cost.`,
    );
  }
  if (unpriced.length > 0) {
    allWarnings.push(
      `No live price for ${unpriced.join(", ")} — shown at cost. Try refreshing market data.`,
    );
  }
  if (unconverted.length > 0) {
    allWarnings.push(
      `Could not convert ${unconverted.join(", ")} to ${base} — missing an FX rate, so ${unconverted.length === 1 ? "it is" : "they are"} excluded from the totals.`,
    );
  }
  if (!isMoney(base)) {
    allWarnings.push(`${base} is not a currency amounts can be stated in.`);
  }

  return {
    positions,
    totals: {
      baseCurrency: base,
      invested: round2(invested),
      marketValue: round2(marketValue),
      unrealizedPnl: round2(unrealizedPnl),
      unrealizedPnlPct: invested > 0 ? (unrealizedPnl / invested) * 100 : 0,
      realizedTotal: round2(realizedTotal),
      positions: positions.length,
      pricedCount: positions.filter((p) => p.price != null).length,
      convertedCount: positions.filter((p) => p.baseCost != null).length,
      periodPnl,
    },
    byMarket,
    byAsset,
    best: ranked[0] ?? null,
    worst: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    realized,
    warnings: allWarnings,
  };
}
