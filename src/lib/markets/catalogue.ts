/**
 * The starting universe.
 *
 * This is *seed data*, not logic. It is written into the `Asset` table once and
 * everything downstream — pricing, movers, allocation, insights — reads the table,
 * never this file. Nothing in the app branches on a ticker. Consequences worth
 * knowing:
 *
 *   - Deleting an entry here does not delete the asset; the table is the truth.
 *   - Holding something that isn't seeded pulls it in automatically (see
 *     `syncLedgerAssets`), so the gainers/losers engine sees your book too.
 *   - Adding a market means adding rows here plus a provider that can quote them.
 *     No engine changes.
 *
 * Every `sourceSymbol` below was verified against its provider before being
 * written down.
 */
import { assetId, type AssetRef, type Market } from "./types";

function seed(
  market: Market,
  symbol: string,
  name: string,
  kind: AssetRef["kind"],
  currency: string,
  source: string,
  sourceSymbol: string,
  rank: number,
): AssetRef {
  return {
    id: assetId(market, symbol),
    market,
    symbol,
    name,
    kind,
    currency,
    source,
    sourceSymbol,
    rank,
    benchmark: true,
  };
}

const y = (
  market: Market,
  symbol: string,
  name: string,
  kind: AssetRef["kind"],
  currency: string,
  sourceSymbol: string,
  rank: number,
) => seed(market, symbol, name, kind, currency, "yahoo", sourceSymbol, rank);

const cg = (symbol: string, name: string, sourceSymbol: string, rank: number) =>
  seed("crypto", symbol, name, "crypto", "USD", "coingecko", sourceSymbol, rank);

/* --------------------------------------------------------------- indices */
// `PTS` is not an ISO currency — it marks a level that is not an amount of money,
// so the formatter prints 7,745.06 rather than "$7,745.06". Same idea as `PCT`
// for a yield.

const INDICES: AssetRef[] = [
  y("indices", "SPX", "S&P 500", "index", "PTS", "^GSPC", 1),
  y("indices", "COMP", "Nasdaq Composite", "index", "PTS", "^IXIC", 2),
  y("indices", "DJI", "Dow Jones Industrial Average", "index", "PTS", "^DJI", 3),
  y("indices", "RUT", "Russell 2000", "index", "PTS", "^RUT", 4),
  y("indices", "VIX", "CBOE Volatility Index", "index", "PTS", "^VIX", 5),
  y("indices", "FTSE100", "FTSE 100", "index", "PTS", "^FTSE", 10),
  y("indices", "DAX", "DAX", "index", "PTS", "^GDAXI", 11),
  y("indices", "N225", "Nikkei 225", "index", "PTS", "^N225", 12),
];

/* ------------------------------------------------------- US stocks + sectors */

const MEGA_CAPS: [string, string][] = [
  ["AAPL", "Apple"],
  ["MSFT", "Microsoft"],
  ["NVDA", "NVIDIA"],
  ["GOOGL", "Alphabet"],
  ["AMZN", "Amazon"],
  ["META", "Meta Platforms"],
  ["TSLA", "Tesla"],
  ["AVGO", "Broadcom"],
  ["BRK-B", "Berkshire Hathaway"],
  ["JPM", "JPMorgan Chase"],
  ["V", "Visa"],
  ["UNH", "UnitedHealth"],
  ["XOM", "Exxon Mobil"],
  ["JNJ", "Johnson & Johnson"],
  ["WMT", "Walmart"],
  ["LLY", "Eli Lilly"],
  ["MA", "Mastercard"],
  ["COST", "Costco"],
  ["HD", "Home Depot"],
  ["NFLX", "Netflix"],
  ["AMD", "Advanced Micro Devices"],
  ["CRM", "Salesforce"],
];

/** Sector ETFs — how "strongest / weakest sector" gets answered without a
 *  sector-classification feed. Each is a liquid, well-known proxy. */
const SECTORS: [string, string][] = [
  ["XLK", "Technology"],
  ["XLF", "Financials"],
  ["XLE", "Energy"],
  ["XLV", "Health Care"],
  ["XLY", "Consumer Discretionary"],
  ["XLP", "Consumer Staples"],
  ["XLI", "Industrials"],
  ["XLB", "Materials"],
  ["XLU", "Utilities"],
  ["XLC", "Communication Services"],
];

const BROAD_ETFS: [string, string][] = [
  ["SPY", "SPDR S&P 500 ETF"],
  ["QQQ", "Invesco QQQ Trust"],
  ["IWM", "iShares Russell 2000 ETF"],
  ["DIA", "SPDR Dow Jones Industrial Average ETF"],
];

const STOCKS: AssetRef[] = [
  ...BROAD_ETFS.map(([s, n], i) => y("stocks", s, n, "etf", "USD", s, 10 + i)),
  ...SECTORS.map(([s, n], i) => y("stocks", s, `${n} Select Sector SPDR`, "etf", "USD", s, 30 + i)),
  ...MEGA_CAPS.map(([s, n], i) => y("stocks", s, n, "stock", "USD", s, 50 + i)),
];

/* ----------------------------------------------------------------- crypto */
// CoinGecko ids, not tickers — "bitcoin", not "BTC". Verified against /coins/list.

const CRYPTO: AssetRef[] = [
  cg("BTC", "Bitcoin", "bitcoin", 1),
  cg("ETH", "Ethereum", "ethereum", 2),
  cg("XRP", "XRP", "ripple", 3),
  cg("BNB", "BNB", "binancecoin", 4),
  cg("SOL", "Solana", "solana", 5),
  cg("DOGE", "Dogecoin", "dogecoin", 6),
  cg("ADA", "Cardano", "cardano", 7),
  cg("TRX", "TRON", "tron", 8),
  cg("AVAX", "Avalanche", "avalanche-2", 9),
  cg("LINK", "Chainlink", "chainlink", 10),
  cg("DOT", "Polkadot", "polkadot", 11),
  cg("LTC", "Litecoin", "litecoin", 12),
];

/* ------------------------------------------------------------ commodities */
// Front-month futures. Agricultural contracts (ZC=F, ZW=F) are deliberately left
// out: they quote in US cents, and mixing a cents-denominated price into the same
// movers table as dollar prices is a bug waiting to happen. Add them with an
// explicit scale factor when they're actually wanted.

const COMMODITIES: AssetRef[] = [
  y("commodities", "XAU", "Gold", "commodity", "USD", "GC=F", 1),
  y("commodities", "XAG", "Silver", "commodity", "USD", "SI=F", 2),
  y("commodities", "WTI", "Crude Oil (WTI)", "commodity", "USD", "CL=F", 3),
  y("commodities", "BRENT", "Crude Oil (Brent)", "commodity", "USD", "BZ=F", 4),
  y("commodities", "NATGAS", "Natural Gas", "commodity", "USD", "NG=F", 5),
  y("commodities", "COPPER", "Copper", "commodity", "USD", "HG=F", 6),
  y("commodities", "XPT", "Platinum", "commodity", "USD", "PL=F", 7),
];

/* ------------------------------------------------------------------ forex */
// Yahoo names a USD-base pair by the quote currency alone ("PKR=X" is USD/PKR)
// and a non-USD base with the full pair ("EURUSD=X"). The `currency` column is
// the *quote* currency, which is what the FX layer converts with.

const FOREX: AssetRef[] = [
  y("forex", "DXY", "US Dollar Index", "index", "PTS", "DX-Y.NYB", 1),
  y("forex", "EURUSD", "Euro / US Dollar", "fx_pair", "USD", "EURUSD=X", 2),
  y("forex", "GBPUSD", "British Pound / US Dollar", "fx_pair", "USD", "GBPUSD=X", 3),
  y("forex", "USDJPY", "US Dollar / Japanese Yen", "fx_pair", "JPY", "USDJPY=X", 4),
  y("forex", "USDCHF", "US Dollar / Swiss Franc", "fx_pair", "CHF", "USDCHF=X", 5),
  y("forex", "AUDUSD", "Australian Dollar / US Dollar", "fx_pair", "USD", "AUDUSD=X", 6),
  y("forex", "USDCAD", "US Dollar / Canadian Dollar", "fx_pair", "CAD", "USDCAD=X", 7),
  y("forex", "USDCNY", "US Dollar / Chinese Yuan", "fx_pair", "CNY", "USDCNY=X", 8),
  y("forex", "USDAED", "US Dollar / UAE Dirham", "fx_pair", "AED", "AED=X", 9),
  y("forex", "USDPKR", "US Dollar / Pakistani Rupee", "fx_pair", "PKR", "PKR=X", 10),
];

/* ------------------------------------------------------------------ bonds */
// Yahoo's ^TNX and friends are quoted as the yield itself (4.724 = 4.724%), so
// `PCT` and a "+12 bps" style read-out rather than a price change.

const BONDS: AssetRef[] = [
  y("bonds", "US10Y", "US 10-Year Treasury Yield", "bond_yield", "PCT", "^TNX", 1),
  y("bonds", "US2Y", "US 2-Year Treasury Yield", "bond_yield", "PCT", "2YY=F", 2),
  y("bonds", "US5Y", "US 5-Year Treasury Yield", "bond_yield", "PCT", "^FVX", 3),
  y("bonds", "US30Y", "US 30-Year Treasury Yield", "bond_yield", "PCT", "^TYX", 4),
  y("bonds", "US3M", "US 13-Week T-Bill Yield", "bond_yield", "PCT", "^IRX", 5),
  y("bonds", "TLT", "iShares 20+ Year Treasury Bond ETF", "etf", "USD", "TLT", 10),
  y("bonds", "IEF", "iShares 7-10 Year Treasury Bond ETF", "etf", "USD", "IEF", 11),
  y("bonds", "SHY", "iShares 1-3 Year Treasury Bond ETF", "etf", "USD", "SHY", 12),
  y("bonds", "AGG", "iShares Core US Aggregate Bond ETF", "etf", "USD", "AGG", 13),
  y("bonds", "LQD", "iShares Investment Grade Corporate Bond ETF", "etf", "USD", "LQD", 14),
  y("bonds", "HYG", "iShares High Yield Corporate Bond ETF", "etf", "USD", "HYG", 15),
];

/* ------------------------------------------------------------ real estate */

const REAL_ESTATE: AssetRef[] = [
  y("real_estate", "VNQ", "Vanguard Real Estate ETF", "reit", "USD", "VNQ", 1),
  y("real_estate", "SCHH", "Schwab US REIT ETF", "reit", "USD", "SCHH", 2),
  y("real_estate", "IYR", "iShares US Real Estate ETF", "reit", "USD", "IYR", 3),
  y("real_estate", "XLRE", "Real Estate Select Sector SPDR", "reit", "USD", "XLRE", 4),
];

/* -------------------------------------------------------------------- PSX */
// Only the index levels are seeded. Individual PSX equities arrive from the
// ledger (`syncLedgerAssets`), because the PSX universe worth tracking is the one
// this user actually holds — seeding all ~550 listings would cost a request each
// on every backfill to price shares nobody owns.

const PSX: AssetRef[] = [
  seed("psx", "KSE100", "KSE 100 Index", "index", "PTS", "psx", "KSE100", 1),
  seed("psx", "KSE30", "KSE 30 Index", "index", "PTS", "psx", "KSE30", 2),
  seed("psx", "KMI30", "KMI 30 Index (Shariah)", "index", "PTS", "psx", "KMI30", 3),
  seed("psx", "ALLSHR", "KSE All Share Index", "index", "PTS", "psx", "ALLSHR", 4),
];

/**
 * The full seeded universe.
 *
 * PSX equities are absent on purpose — see the note above `PSX`.
 */
export const CATALOGUE: AssetRef[] = [
  ...PSX,
  ...INDICES,
  ...STOCKS,
  ...CRYPTO,
  ...COMMODITIES,
  ...FOREX,
  ...BONDS,
  ...REAL_ESTATE,
];
