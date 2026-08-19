/**
 * What to call a thing when asking about it, and what to recognise it by.
 *
 * One definition serves two callers that would otherwise drift apart: the search
 * providers, which need a phrase to put in a query ("Gold" price, not XAU), and
 * the matcher, which needs every string whose presence in a headline implies the
 * asset. Splitting those meant a search for "gold" whose results the matcher then
 * failed to recognise as being about `commodities:XAU`.
 *
 * Data, not logic — in the spirit of `markets/catalogue.ts`. Adding an asset
 * needs nothing here; adding an entry only sharpens one that already works.
 *
 * Pure.
 */
import { isNotional, type AssetRef, type Market } from "@/lib/markets/types";

export interface SearchTerms {
  /** The phrase to hand a search-based provider. */
  query: string;
  /**
   * Strings whose presence implies this asset. Phrases are matched
   * case-insensitively on word boundaries; `symbols` are matched as uppercase
   * tokens, which is a different and much stricter test.
   */
  aliases: string[];
  symbols: string[];
}

/**
 * Tickers that are also ordinary words or well-known acronyms.
 *
 * A headline containing "ALL" or "COST" is almost never about Allied or Costco,
 * and uppercase matching alone does not save us — headlines shout. Excluded from
 * symbol matching only; each of these is still reachable by name ("Costco",
 * "Chainlink"), which is the more reliable signal anyway.
 */
const AMBIGUOUS_SYMBOLS = new Set([
  "ALL", "AND", "ARE", "CAN", "COST", "FOR", "HAS", "KEY", "NEW", "ONE", "OUT", "SEE", "THE",
  "ADA", "DOT", "LINK", "SHY", "AGG",
  "CEO", "CFO", "CPI", "GDP", "FED", "ETF", "IPO", "SEC", "IRS", "EPS",
  "USA", "USD", "EUR", "GBP", "JPY", "PKR", "UAE",
]);

/**
 * Synonyms headlines actually use, where the catalogue name is not it.
 *
 * Hand-written and deliberately short: this is for the cases where a publisher
 * has a settled house word ("bullion", "the Dow", "greenback") that no rule
 * could derive from a catalogue row.
 */
const EXTRA_ALIASES: Record<string, string[]> = {
  "commodities:XAU": ["bullion", "gold price", "gold prices"],
  "commodities:XAG": ["silver price", "silver prices"],
  "commodities:WTI": ["crude oil", "oil prices", "WTI crude"],
  "commodities:BRENT": ["Brent crude", "Brent oil"],
  "commodities:NATGAS": ["natural gas", "nat gas"],
  "commodities:COPPER": ["copper prices"],
  "indices:SPX": ["S&P", "S&P 500", "S&P500"],
  "indices:COMP": ["Nasdaq", "Nasdaq Composite"],
  "indices:DJI": ["Dow Jones", "the Dow"],
  "indices:RUT": ["Russell 2000", "small caps", "small-cap stocks"],
  "indices:VIX": ["volatility index", "fear gauge"],
  "indices:FTSE100": ["FTSE"],
  "indices:N225": ["Nikkei"],
  "forex:DXY": ["dollar index", "greenback"],
  "forex:USDPKR": ["Pakistani rupee", "rupee"],
  "forex:EURUSD": ["euro"],
  "forex:USDJPY": ["yen"],
  "bonds:US10Y": ["10-year Treasury", "10-year yield", "Treasury yields"],
  "bonds:US2Y": ["2-year Treasury", "2-year yield"],
  "bonds:US30Y": ["30-year Treasury", "long bond"],
  "stocks:GOOGL": ["Google"],
  "stocks:META": ["Facebook", "Instagram"],
  "stocks:BRK-B": ["Berkshire"],
  "stocks:AMD": ["AMD"],
  "crypto:XRP": ["Ripple"],
  "crypto:BTC": ["bitcoin"],
  "crypto:ETH": ["ether", "ethereum"],
  "psx:KSE100": ["KSE-100", "KSE 100"],
  "psx:KSE30": ["KSE-30"],
  "psx:KMI30": ["KMI-30"],
};

/**
 * Whether an asset's catalogue name is specific enough to match a headline on.
 *
 * "Apple" and "Bitcoin" are; "Technology Select Sector SPDR" never appears in
 * prose, and its first word alone would match every technology story ever
 * written. Fund names are matched by ticker instead, which is what a headline
 * about an ETF uses anyway.
 */
function nameIsSearchable(asset: AssetRef): boolean {
  return asset.kind !== "etf" && asset.kind !== "reit" && asset.name.length >= 3;
}

/** The half of an FX pair that isn't the dollar — the side a story is about. */
function fxSubject(name: string): string {
  const sides = name.split("/").map((s) => s.trim());
  if (sides.length !== 2) return name;
  const other = sides.find((s) => !/^(us )?dollar$/i.test(s));
  return other ?? sides[1];
}

function quoted(s: string): string {
  return `"${s}"`;
}

/** The phrase a search provider should use for one asset. */
function queryFor(asset: AssetRef): string {
  if (asset.market === "psx") {
    return `${quoted(asset.symbol)} Pakistan Stock Exchange`;
  }
  switch (asset.kind) {
    case "crypto":
      return `${quoted(asset.name)} crypto`;
    case "commodity":
      return `${quoted(asset.name)} price`;
    case "fx_pair":
      return `${quoted(fxSubject(asset.name))} exchange rate`;
    case "bond_yield":
      return `${quoted(asset.name)} bond market`;
    case "etf":
    case "reit":
      return `${quoted(asset.symbol)} ETF`;
    case "index":
      return quoted(asset.name);
    default:
      return `${quoted(asset.name)} stock`;
  }
}

/** Everything worth knowing about how to look one asset up. */
export function assetTerms(asset: AssetRef): SearchTerms {
  const aliases = new Set<string>();
  if (nameIsSearchable(asset)) aliases.add(asset.name);
  // "US Dollar / UAE Dirham" is a catalogue label, never a sentence. A story
  // about the pair names one side of it, so that is what has to be matchable.
  if (asset.kind === "fx_pair") aliases.add(fxSubject(asset.name));
  for (const extra of EXTRA_ALIASES[asset.id] ?? []) aliases.add(extra);

  const symbols = new Set<string>();
  const symbol = asset.symbol.toUpperCase();
  // Two-character tickers (V, MA, HD) collide with initials and abbreviations far
  // too often to be worth the recall.
  if (symbol.length >= 3 && !AMBIGUOUS_SYMBOLS.has(symbol)) symbols.add(symbol);

  return { query: queryFor(asset), aliases: [...aliases], symbols: [...symbols] };
}

/**
 * The phrase for a whole market.
 *
 * Notional markets (indices, bonds) ask about the thing the level represents,
 * not the level — nobody writes about "the indices market".
 */
const MARKET_QUERIES: Record<Market, string> = {
  stocks: "stock market",
  crypto: "cryptocurrency market",
  commodities: "commodity prices",
  forex: "currency markets dollar",
  indices: "stock market index",
  bonds: "bond market Treasury yields",
  real_estate: "real estate market REITs",
  psx: "Pakistan Stock Exchange KSE-100",
};

export function marketTerms(market: Market): SearchTerms {
  return { query: MARKET_QUERIES[market], aliases: [], symbols: [] };
}

/**
 * Whether an asset is worth spending a per-asset news lookup on at all.
 *
 * A Treasury yield and an index level move because the whole market did; there
 * is no story about `bonds:US5Y` specifically, and asking for one returns the
 * same macro coverage the market-level query already fetched. Their moves still
 * matter — they just get explained by market news rather than their own.
 */
export function hasOwnStory(asset: AssetRef): boolean {
  return !isNotional(asset.kind);
}
