/**
 * The vocabulary every market shares.
 *
 * One rule holds this together: an `Asset` is a market plus a symbol, and nothing
 * downstream — pricing, performance, allocation, insights — is allowed to care
 * which market it came from. Adding an asset class means adding a `Market` entry
 * and a provider that can quote it, not touching the engines.
 *
 * Pure types and pure functions only. No Prisma, no fetch — so the check script
 * can exercise the whole vocabulary without a database or a network.
 */

/* ------------------------------------------------------------------ markets */

/**
 * The asset classes the app is structured around. Order is display order.
 *
 * `psx` sits alongside the global markets rather than under `stocks`: it settles
 * in PKR, trades on its own calendar, and is priced by a different provider. That
 * is exactly the shape a market is meant to have.
 */
export const MARKETS = [
  "stocks",
  "crypto",
  "commodities",
  "forex",
  "indices",
  "bonds",
  "real_estate",
  "psx",
] as const;

export type Market = (typeof MARKETS)[number];

export interface MarketMeta {
  id: Market;
  label: string;
  /** One line for the market card — what this market actually is. */
  blurb: string;
  /** The asset whose move represents the market as a whole on the overview. */
  headline: string | null;
}

export const MARKET_META: Record<Market, MarketMeta> = {
  stocks: {
    id: "stocks",
    label: "US Stocks",
    blurb: "US equities and ETFs",
    headline: "indices:SPX",
  },
  crypto: {
    id: "crypto",
    label: "Crypto",
    blurb: "Digital assets by market cap",
    headline: "crypto:BTC",
  },
  commodities: {
    id: "commodities",
    label: "Commodities",
    blurb: "Metals and energy futures",
    headline: "commodities:XAU",
  },
  forex: {
    id: "forex",
    label: "Forex",
    blurb: "Major currency pairs",
    headline: "forex:DXY",
  },
  indices: {
    id: "indices",
    label: "Indices",
    blurb: "Benchmark and volatility indices",
    headline: "indices:SPX",
  },
  bonds: {
    id: "bonds",
    label: "Bonds",
    blurb: "Treasury yields and bond ETFs",
    headline: "bonds:US10Y",
  },
  real_estate: {
    id: "real_estate",
    label: "Real Estate",
    blurb: "REIT ETFs and property proxies",
    headline: "real_estate:VNQ",
  },
  psx: {
    id: "psx",
    label: "Pakistan (PSX)",
    blurb: "Pakistan Stock Exchange equities",
    headline: "psx:KSE100",
  },
};

export function isMarket(v: unknown): v is Market {
  return typeof v === "string" && (MARKETS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------- assets */

/**
 * What kind of instrument this is. Distinct from `Market` on purpose: a REIT ETF
 * is an `etf` traded in `real_estate`, and a bond yield is not a tradable price
 * at all, which the formatters need to know.
 */
export const ASSET_KINDS = [
  "stock",
  "etf",
  "reit",
  "index",
  "crypto",
  "commodity",
  "fx_pair",
  "bond_yield",
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export function isAssetKind(v: unknown): v is AssetKind {
  return typeof v === "string" && (ASSET_KINDS as readonly string[]).includes(v);
}

/** Kinds whose "price" is a level or a percentage, never an amount of money. */
export function isNotional(kind: AssetKind): boolean {
  return kind === "index" || kind === "bond_yield";
}

export interface AssetRef {
  /** `{market}:{symbol}` — stable, readable, unique across markets. */
  id: string;
  market: Market;
  symbol: string;
  name: string;
  kind: AssetKind;
  /** ISO currency the price is quoted in. "PTS" for an index, "PCT" for a yield. */
  currency: string;
  /** Which provider quotes it, and what that provider calls it. */
  source: string;
  sourceSymbol: string;
  rank: number;
  /** Seeded as part of the market overview, rather than pulled in by a holding. */
  benchmark: boolean;
}

/** Build the canonical asset id. The one place this format is defined. */
export function assetId(market: Market, symbol: string): string {
  return `${market}:${symbol.toUpperCase()}`;
}

/** Split an asset id back apart. Returns null for anything malformed. */
export function parseAssetId(id: string): { market: Market; symbol: string } | null {
  const at = id.indexOf(":");
  if (at <= 0 || at === id.length - 1) return null;
  const market = id.slice(0, at);
  if (!isMarket(market)) return null;
  return { market, symbol: id.slice(at + 1) };
}

/* -------------------------------------------------------------------- data */

/** A point-in-time snapshot. `changePct` is against the previous session close. */
export interface QuoteData {
  assetId: string;
  price: number;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  marketTime: Date | null;
  source: string;
}

/** One daily close. `date` is yyyy-mm-dd, matching the ledger's date convention. */
export interface BarData {
  assetId: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  source: string;
}

/* ---------------------------------------------------------------- providers */

/**
 * How far back to ask a provider for daily bars.
 *
 * `"none"` means quote-only. Daily closes do not change intraday, so the frequent
 * refresh skips history entirely and only the daily backfill pays for it — which
 * is what keeps a metered provider like CoinGecko inside its monthly allowance.
 */
export type HistoryRange = "none" | "1mo" | "3mo" | "6mo" | "1y" | "2y";

/** Calendar days each range covers, for providers that want a day count. */
export const RANGE_DAYS: Record<Exclude<HistoryRange, "none">, number> = {
  "1mo": 30,
  "3mo": 90,
  "6mo": 180,
  "1y": 365,
  "2y": 730,
};

/**
 * What one provider returns for one asset. A provider reports its own failures
 * per-asset rather than throwing, so one dead symbol never costs a whole refresh.
 */
export interface ProviderQuoteResult {
  assetId: string;
  quote: QuoteData | null;
  bars: BarData[];
  error: string | null;
}

/**
 * A source of market data.
 *
 * Deliberately one combined `fetch` rather than the separate getQuote /
 * getHistoricalPrices pair you might expect: the endpoints that actually exist
 * return the snapshot and the daily series in the same response, so splitting
 * them would double the request count for no gain. `getQuotes`/`getHistory` in
 * `registry.ts` are thin conveniences over this.
 *
 * Note what is NOT here: market overviews and top movers. Those are computed from
 * stored bars by `performance.ts`, so they work identically for every provider —
 * including ones with no "movers" endpoint at all.
 */
export interface MarketDataProvider {
  readonly id: string;
  readonly label: string;
  /** Whether this provider can quote the asset at all. */
  supports(asset: AssetRef): boolean;
  /**
   * Quote (and where available, backfill) the given assets. Must resolve for
   * every input asset, using `error` to report the ones it could not price.
   */
  fetch(assets: AssetRef[], range: HistoryRange): Promise<ProviderQuoteResult[]>;
}

/** Thrown when a provider is reachable but answered with something unusable. */
export class ProviderError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
  ) {
    super(`[${providerId}] ${message}`);
  }
}
