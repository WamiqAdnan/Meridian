/**
 * Standalone checks for the portfolio layer: asset resolution, manual-trade
 * validation, and the multi-market portfolio engine.
 *
 * Run: npm run check:portfolio
 *
 * No network and no database. Every number below is worked out by hand in the
 * comments beside it, so a change that moves one is visible as a change in
 * meaning rather than as a mysterious failing assertion.
 */
import { buildManualTrade, isIsoDate, manualTradeNo, resolveAssetId, MANUAL_BROKER } from "@/lib/ledger";
import { INVESTORS } from "@/lib/investors";
import { buildFxTable } from "@/lib/markets/currency";
import { computePerformance } from "@/lib/markets/performance";
import type { BarData } from "@/lib/markets/types";
import {
  buildPortfolio,
  isBaseCurrency,
  toBaseCurrency,
  type PortfolioTrade,
  type PricedAsset,
} from "@/lib/portfolio";

/**
 * A valid owner, taken from the configured list rather than written out, so
 * these checks say the same thing whether or not NEXT_PUBLIC_INVESTORS is set in
 * the shell that runs them. "Nobody" below is the counterpart: a string the list
 * cannot contain.
 */
const OWNER = INVESTORS[0];

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail?: string) {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

function eq(label: string, actual: unknown, expected: unknown) {
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function near(label: string, actual: number | null | undefined, expected: number, tol = 0.005) {
  ok(
    label,
    actual != null && Math.abs(actual - expected) <= tol,
    `got ${actual}, want ${expected} ±${tol}`,
  );
}

function section(name: string) {
  console.log(`\n${name}`);
}

/* --------------------------------------------------------- asset resolution */

function checkResolution() {
  section("Asset resolution");

  eq(
    "an explicit assetId wins",
    resolveAssetId({ security: "LUCK", assetId: "stocks:LUCK" }),
    "stocks:LUCK",
  );
  eq(
    "a pre-markets row falls back to PSX",
    resolveAssetId({ security: "LUCK", assetId: null }),
    "psx:LUCK",
  );
  eq("the fallback uppercases", resolveAssetId({ security: "luck" }), "psx:LUCK");
  eq(
    "an empty assetId is treated as absent",
    resolveAssetId({ security: "ATRL", assetId: "  " }),
    "psx:ATRL",
  );
  eq(
    "a crypto row is never rewritten to PSX",
    resolveAssetId({ security: "BTC", assetId: "crypto:BTC" }),
    "crypto:BTC",
  );

  /*
   * `security` alone never decides a market.
   *
   * `syncLedgerAssets` creates a PSX `Asset` for anything the ledger refers to
   * that the catalogue lacks, and it has to read the market off `resolveAssetId`
   * rather than off `security`. A hand-entered trade stores a bare ticker in
   * `security` exactly like a PDF import does — the market is only in `assetId` —
   * so `psx:{security}` invented a phantom PSX equity for every non-PSX position:
   * a bogus row in the PSX listing and movers table, and a symbol nothing can
   * ever price, since market-watch has never heard of it and `yahooSymbolFor`
   * declines anything in the `psx` market.
   *
   * These assert the decision the sync depends on, over the rows the writers
   * actually produce.
   */
  for (const [market, symbol] of [
    ["crypto", "BTC"],
    ["stocks", "AAPL"],
    ["commodities", "XAU"],
  ] as const) {
    const built = buildManualTrade(
      { owner: OWNER, side: "BUY", tradeDate: "2026-08-01", qty: "1", rate: "100" },
      { id: `${market}:${symbol}`, symbol, market },
    );
    ok(`a manual ${market} trade is buildable`, built.ok, built.ok ? "" : built.errors.join(" "));
    if (!built.ok) continue;
    eq(
      `a manual ${market} trade stores a bare ticker in security`,
      built.trade.security,
      symbol,
    );
    eq(
      `and still resolves to ${market}, not psx`,
      resolveAssetId(built.trade),
      `${market}:${symbol}`,
    );
  }
}

/* ------------------------------------------------------------- manual entry */

const NOW = new Date("2026-08-18T09:30:00.000Z");
const ASSET = { id: "crypto:BTC", symbol: "BTC", market: "crypto" as const };

function checkManualEntry() {
  section("Manual trade entry");

  eq("a real date passes", isIsoDate("2026-08-18"), true);
  eq("a malformed date fails", isIsoDate("18-08-2026"), false);
  eq("a non-existent day fails", isIsoDate("2026-02-30"), false);
  eq("a leap day passes", isIsoDate("2024-02-29"), true);
  eq("a non-leap 29 Feb fails", isIsoDate("2026-02-29"), false);

  const good = buildManualTrade(
    { owner: OWNER, side: "buy", tradeDate: "2026-08-17", qty: "0.05", rate: "80,000", fees: "12.5" },
    ASSET,
    { now: NOW, tradeNo: "M-TEST" },
  );
  ok("a well-formed BUY validates", good.ok, good.ok ? "" : good.errors.join("; "));
  if (good.ok) {
    eq("side is normalised to upper case", good.trade.side, "BUY");
    eq("the broker slug marks it manual", good.trade.broker, MANUAL_BROKER);
    eq("security is the asset's symbol", good.trade.security, "BTC");
    eq("assetId is carried explicitly", good.trade.assetId, "crypto:BTC");
    near("a fractional quantity survives", good.trade.qty, 0.05);
    near("thousands separators are read", good.trade.rate, 80000);
    // 0.05 * 80,000 = 4,000
    near("gross is rate * qty", good.trade.grossAmount, 4000);
    // A BUY costs the fees on top: 4,000 + 12.50
    near("a BUY nets gross + fees", good.trade.netAmount, 4012.5);
    near("fees land in brokerage", good.trade.brokerage, 12.5);
    near("cvt is zero for a manual row", good.trade.cvt, 0);
    eq("settlement defaults to the trade date", good.trade.settlementDate, "2026-08-17");
  }

  const sell = buildManualTrade(
    { owner: OWNER, side: "SELL", tradeDate: "2026-08-17", qty: 2, rate: 100, fees: 5 },
    ASSET,
    { now: NOW },
  );
  ok("a well-formed SELL validates", sell.ok);
  // 2 * 100 = 200 gross, less 5 in fees
  if (sell.ok) near("a SELL nets gross - fees", sell.trade.netAmount, 195);

  const free = buildManualTrade(
    { owner: OWNER, side: "BUY", tradeDate: "2026-08-17", qty: 10, rate: 0 },
    ASSET,
    { now: NOW },
  );
  ok("a zero price is allowed (airdrop, bonus issue)", free.ok);
  if (free.ok) near("fees default to zero", free.trade.brokerage, 0);

  const bad = buildManualTrade(
    { owner: "Nobody", side: "HOLD", tradeDate: "2026-13-01", qty: "-1", rate: "abc", fees: "-2" },
    ASSET,
    { now: NOW },
  );
  eq("a bad input is rejected", bad.ok, false);
  if (!bad.ok) {
    ok("every problem is reported at once", bad.errors.length >= 5, `got ${bad.errors.length}`);
    ok("the owner is named", bad.errors.some((e) => e.includes("belongs to")));
    ok("the side is named", bad.errors.some((e) => e.includes("BUY or SELL")));
  }

  const future = buildManualTrade(
    { owner: OWNER, side: "BUY", tradeDate: "2026-08-19", qty: 1, rate: 1 },
    ASSET,
    { now: NOW },
  );
  eq("a future trade date is rejected", future.ok, false);

  const today = buildManualTrade(
    { owner: OWNER, side: "BUY", tradeDate: "2026-08-18", qty: 1, rate: 1 },
    ASSET,
    { now: NOW },
  );
  ok("today is not the future", today.ok);

  const zeroQty = buildManualTrade(
    { owner: OWNER, side: "BUY", tradeDate: "2026-08-18", qty: 0, rate: 10 },
    ASSET,
    { now: NOW },
  );
  eq("a zero quantity is rejected", zeroQty.ok, false);

  const blankQty = buildManualTrade(
    { owner: OWNER, side: "BUY", tradeDate: "2026-08-18", qty: "", rate: 10 },
    ASSET,
    { now: NOW },
  );
  eq("a blank quantity is not read as zero", blankQty.ok, false);

  const no = manualTradeNo(NOW, "abcd");
  eq("a manual trade number is stamped and readable", no, "M-20260818T0930-abcd");
  ok(
    "manual trade numbers sort by entry time",
    manualTradeNo(new Date("2026-08-18T08:00:00Z"), "0000") <
      manualTradeNo(new Date("2026-08-18T09:00:00Z"), "0000"),
  );
}

/* ------------------------------------------------------------ base currency */

function checkBaseCurrency() {
  section("Base currency");
  eq("PKR is a base currency", isBaseCurrency("PKR"), true);
  eq("USD is a base currency", isBaseCurrency("USD"), true);
  eq("an unknown code is not", isBaseCurrency("XYZ"), false);
  eq("an untrusted value falls back to PKR", toBaseCurrency("nonsense"), "PKR");
  eq("a valid value is kept", toBaseCurrency("USD"), "USD");
}

/* ------------------------------------------------------------ the portfolio */

// 1 USD = 277.60 PKR, learned from the ordinary USDPKR asset.
const FX = buildFxTable([{ symbol: "USDPKR", currency: "PKR", price: 277.6 }]);

/** 40 consecutive sessions ending 2026-08-18, closing 200 → 239. */
function aaplBars(): BarData[] {
  const bars: BarData[] = [];
  const start = new Date("2026-07-10T00:00:00Z");
  for (let i = 0; i < 40; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    bars.push({
      assetId: "stocks:AAPL",
      date: d.toISOString().slice(0, 10),
      open: null,
      high: null,
      low: null,
      close: 200 + i,
      volume: null,
      source: "test",
    });
  }
  return bars;
}

function asset(over: Partial<PricedAsset> & Pick<PricedAsset, "id">): PricedAsset {
  return {
    market: "stocks",
    symbol: over.id.split(":")[1],
    name: over.id,
    kind: "stock",
    currency: "USD",
    price: null,
    changePct: null,
    ...over,
  };
}

function trade(over: Partial<PortfolioTrade> & Pick<PortfolioTrade, "assetId">): PortfolioTrade {
  return {
    security: over.assetId?.split(":")[1] ?? "UNKNOWN",
    tradeNo: "T1",
    tradeDate: "2026-01-02",
    side: "BUY",
    rate: 1,
    qty: 1,
    brokerage: 0,
    cvt: 0,
    ...over,
  };
}

function checkPortfolio() {
  section("Portfolio engine");

  const assets: PricedAsset[] = [
    asset({ id: "psx:LUCK", market: "psx", currency: "PKR", price: 200, changePct: 1.5 }),
    asset({
      id: "stocks:AAPL",
      price: 250,
      changePct: -0.4,
      performance: computePerformance("stocks:AAPL", aaplBars()),
    }),
    asset({ id: "crypto:BTC", market: "crypto", kind: "crypto", price: 100000 }),
    // Same ticker, different market — the collision that keying by symbol loses.
    asset({ id: "stocks:LUCK", price: 50 }),
  ];

  const trades: PortfolioTrade[] = [
    trade({ assetId: "psx:LUCK", tradeNo: "1", rate: 150, qty: 100 }),
    trade({ assetId: "stocks:AAPL", tradeNo: "2", rate: 200, qty: 10 }),
    trade({ assetId: "crypto:BTC", tradeNo: "3", rate: 80000, qty: 0.05 }),
    trade({ assetId: "stocks:LUCK", tradeNo: "4", rate: 45, qty: 10 }),
  ];

  const p = buildPortfolio(trades, { assets, fx: FX, baseCurrency: "PKR" });

  eq("one position per asset", p.positions.length, 4);
  eq(
    "two markets can both list LUCK",
    p.positions.filter((x) => x.symbol === "LUCK").length,
    2,
  );

  const psxLuck = p.positions.find((x) => x.assetId === "psx:LUCK")!;
  const aapl = p.positions.find((x) => x.assetId === "stocks:AAPL")!;
  const btc = p.positions.find((x) => x.assetId === "crypto:BTC")!;

  // psx:LUCK — 100 @ 150 = Rs 15,000 cost, 100 @ 200 = Rs 20,000 value.
  near("a PKR position costs what it cost", psxLuck.totalCost, 15000);
  near("a PKR position is worth qty * price", psxLuck.marketValue, 20000);
  eq("a PKR position needs no conversion", psxLuck.currency, "PKR");
  near("base cost equals native cost in PKR", psxLuck.baseCost, 15000);

  // stocks:AAPL — 10 @ 200 = $2,000 cost, 10 @ 250 = $2,500 value.
  near("a USD position keeps its native value", aapl.marketValue, 2500);
  eq("a USD position says so", aapl.currency, "USD");
  // $2,500 * 277.60 = Rs 694,000
  near("a USD position converts into the base currency", aapl.baseValue, 694000);
  // $2,000 * 277.60 = Rs 555,200
  near("cost converts too", aapl.baseCost, 555200);
  near("unrealized P&L is native", aapl.unrealizedPnl, 500);
  near("unrealized P&L converts", aapl.baseUnrealizedPnl, 138800);
  near("unrealized return is a native ratio", aapl.unrealizedPnlPct, 25);
  near("the day move comes from the quote", aapl.dayChangePct, -0.4);

  // crypto:BTC — 0.05 @ 80,000 = $4,000, now 0.05 @ 100,000 = $5,000.
  near("a fractional quantity is held exactly", btc.qty, 0.05);
  near("a fractional position is valued correctly", btc.marketValue, 5000);

  // Invested: 15,000 + 555,200 + 1,110,400 + 124,920 = Rs 1,805,520
  near("invested totals in the base currency", p.totals.invested, 1805520);
  // Value: 20,000 + 694,000 + 1,388,000 + 138,800 = Rs 2,240,800
  near("market value totals in the base currency", p.totals.marketValue, 2240800);
  near("unrealized P&L is the difference", p.totals.unrealizedPnl, 435280);
  eq("the base currency is stated", p.totals.baseCurrency, "PKR");
  eq("every position is priced", p.totals.pricedCount, 4);
  eq("every position converts", p.totals.convertedCount, 4);
  ok("a clean portfolio warns about nothing", p.warnings.length === 0, p.warnings.join("; "));

  const weightSum = p.positions.reduce((s, x) => s + (x.weightPct ?? 0), 0);
  near("weights sum to 100%", weightSum, 100, 0.001);
  // Rs 1,388,000 / Rs 2,240,800 = 61.94%
  near("a weight is a share of market value", btc.weightPct, 61.94, 0.01);

  eq("allocation is grouped by market", p.byMarket.length, 3);
  eq("the largest market sorts first", p.byMarket[0].key, "crypto");
  // stocks holds AAPL (694,000) + LUCK (138,800) = Rs 832,800
  near("a market's value sums its positions", p.byMarket.find((m) => m.key === "stocks")!.value, 832800);
  near(
    "market weights sum to 100%",
    p.byMarket.reduce((s, m) => s + m.weightPct, 0),
    100,
    0.001,
  );
  eq("allocation by asset is sorted by value", p.byAsset[0].key, "crypto:BTC");

  // psx:LUCK +33.33%, AAPL/BTC +25%, stocks:LUCK +11.11%
  eq("the best performer is by return, not size", p.best?.assetId, "psx:LUCK");
  eq("the worst performer is the weakest return", p.worst?.assetId, "stocks:LUCK");

  /* ---- windowed P&L, which comes from bars rather than the live quote ---- */

  // Latest bar closes 239 against 238 the session before: +$1 on 10 shares.
  near("the day window moves with the bars", aapl.periodPnl.day, 2776);
  // 2026-08-11 closed 232; 239 - 232 = +$7 on 10 shares = $70.
  near("the week window reaches back a week", aapl.periodPnl.week, 19432);
  // 2026-07-19 closed 209; 239 - 209 = +$30 on 10 shares = $300.
  near("the month window reaches back a month", aapl.periodPnl.month, 83280);
  near("the window's own percentage is reported", aapl.periodChangePct.week, (7 / 232) * 100);
  ok(
    "a window is measured on bars, not on the live quote",
    aapl.price === 250 && aapl.periodChangePct.day != null && aapl.periodChangePct.day < 1,
  );
  eq("an asset with no history contributes no window", btc.periodPnl.week, null);
  // Only AAPL has bars, so the portfolio's window is AAPL's alone.
  near("portfolio windows sum what they can", p.totals.periodPnl.week, 19432);
}

function checkDegradedPortfolio() {
  section("Portfolio engine — missing data");

  const assets: PricedAsset[] = [
    asset({ id: "psx:LUCK", market: "psx", currency: "PKR", price: null }),
    asset({ id: "stocks:AAPL", currency: "XYZ", price: 100 }),
    asset({ id: "indices:SPX", market: "indices", kind: "index", currency: "PTS", price: 7000 }),
  ];

  const trades: PortfolioTrade[] = [
    trade({ assetId: "psx:LUCK", tradeNo: "1", rate: 150, qty: 100 }),
    trade({ assetId: "stocks:AAPL", tradeNo: "2", rate: 80, qty: 10 }),
    trade({ assetId: "indices:SPX", tradeNo: "3", rate: 6000, qty: 1 }),
    trade({ assetId: "commodities:UNOBTANIUM", tradeNo: "4", rate: 5, qty: 3 }),
  ];

  const p = buildPortfolio(trades, { assets, fx: FX, baseCurrency: "PKR" });

  const luck = p.positions.find((x) => x.assetId === "psx:LUCK")!;
  eq("an unpriced position has no market value", luck.marketValue, null);
  near("an unpriced position still reports its cost", luck.baseCost, 15000);
  ok("the unpriced position is named in a warning", p.warnings.some((w) => w.includes("No live price")));

  const aapl = p.positions.find((x) => x.assetId === "stocks:AAPL")!;
  eq("an unconvertible currency yields no base cost", aapl.baseCost, null);
  eq("...and no base value", aapl.baseValue, null);
  near("...but the native value is still right", aapl.marketValue, 1000);
  ok(
    "the unconvertible position is named in a warning",
    p.warnings.some((w) => w.includes("Could not convert") && w.includes("AAPL")),
  );

  const spx = p.positions.find((x) => x.assetId === "indices:SPX")!;
  eq("a notional currency never converts", spx.baseCost, null);

  const unknown = p.positions.find((x) => x.assetId === "commodities:UNOBTANIUM")!;
  ok("a holding outside the catalogue is still listed", unknown != null);
  near("...and is carried at cost", unknown.totalCost, 15);
  eq("...filed under the market its id names", unknown.market, "commodities");
  eq("...with no currency invented for it", unknown.currency, null);
  eq("...so it never reaches the base total", unknown.baseCost, null);
  ok(
    "the uncatalogued holding is named in a warning",
    p.warnings.some((w) => w.includes("not in the asset catalogue")),
  );

  eq("only the position with a known currency converts", p.totals.convertedCount, 1);
  // Only psx:LUCK converts: Rs 15,000 cost, no price, so value falls back to cost.
  near("the total covers only what converts", p.totals.marketValue, 15000);
  eq("no window can be computed", p.totals.periodPnl.day, null);
}

function checkImpliedPsxCurrency() {
  section("Portfolio engine — a PSX row with no asset");

  // The whole `Asset` table can be wiped and reseeded; the ledger cannot. A PSX
  // holding must survive that gap, because the PSX settles in rupees and nothing
  // else — which is the one currency that is safe to infer.
  const p = buildPortfolio(
    [trade({ assetId: null, security: "LUCK", tradeNo: "1", rate: 150, qty: 100 })],
    { assets: [], fx: FX, baseCurrency: "PKR" },
  );

  const luck = p.positions[0];
  eq("a pre-markets row resolves to PSX", luck.assetId, "psx:LUCK");
  eq("...and PSX implies rupees", luck.currency, "PKR");
  near("...so it still counts toward the total", p.totals.invested, 15000);
  eq("...and is counted as converted", p.totals.convertedCount, 1);
}

function checkRealizedAndSells() {
  section("Portfolio engine — sells");

  const assets: PricedAsset[] = [
    asset({ id: "psx:LUCK", market: "psx", currency: "PKR", price: 200 }),
    asset({ id: "stocks:AAPL", price: 250 }),
  ];

  const trades: PortfolioTrade[] = [
    trade({ assetId: "psx:LUCK", tradeNo: "1", tradeDate: "2026-01-02", rate: 150, qty: 100 }),
    // Sell 20 at 250 against a Rs 150 average: 20 * 100 = Rs 2,000 realized.
    trade({ assetId: "psx:LUCK", tradeNo: "2", tradeDate: "2026-03-02", side: "SELL", rate: 250, qty: 20 }),
    trade({ assetId: "stocks:AAPL", tradeNo: "3", tradeDate: "2026-01-02", rate: 200, qty: 10 }),
    // Sell 4 at $300 against a $200 average: 4 * 100 = $400 realized.
    trade({ assetId: "stocks:AAPL", tradeNo: "4", tradeDate: "2026-03-02", side: "SELL", rate: 300, qty: 4 }),
  ];

  const p = buildPortfolio(trades, { assets, fx: FX, baseCurrency: "PKR" });

  const luck = p.positions.find((x) => x.assetId === "psx:LUCK")!;
  eq("a sell reduces the quantity", luck.qty, 80);
  near("...and scales the cost proportionally", luck.totalCost, 12000);
  near("...leaving the average cost intact", luck.avgCostInclFees, 150);

  const luckRealized = p.realized.find((r) => r.assetId === "psx:LUCK")!;
  const aaplRealized = p.realized.find((r) => r.assetId === "stocks:AAPL")!;
  near("realized P&L is booked per asset in its own currency", luckRealized.amount, 2000);
  eq("...and says which currency that is", luckRealized.currency, "PKR");
  near("...for a USD asset too", aaplRealized.amount, 400);
  eq("...in dollars", aaplRealized.currency, "USD");
  // $400 * 277.60 = Rs 111,040
  near("...alongside the converted figure", aaplRealized.baseAmount, 111040);
  eq("the largest booked gain sorts first", p.realized[0].assetId, "stocks:AAPL");
  // Rs 2,000 + ($400 * 277.60 = Rs 111,040) = Rs 113,040
  near("realized P&L totals in the base currency", p.totals.realizedTotal, 113040);

  const oversold = buildPortfolio(
    [
      trade({ assetId: "psx:LUCK", tradeNo: "1", tradeDate: "2026-01-02", rate: 150, qty: 10 }),
      trade({ assetId: "psx:LUCK", tradeNo: "2", tradeDate: "2026-03-02", side: "SELL", rate: 200, qty: 50 }),
    ],
    { assets, fx: FX, baseCurrency: "PKR" },
  );
  ok(
    "an over-sell is still surfaced through the portfolio",
    oversold.warnings.some((w) => w.includes("Over-sell")),
  );
  eq("...and closes the position rather than going negative", oversold.positions.length, 0);
}

function checkEmptyAndUsdBase() {
  section("Portfolio engine — edges");

  const empty = buildPortfolio([], { assets: [], fx: FX, baseCurrency: "PKR" });
  eq("an empty ledger has no positions", empty.positions.length, 0);
  eq("...and totals zero", empty.totals.marketValue, 0);
  eq("...without dividing by zero", empty.totals.unrealizedPnlPct, 0);
  eq("...and names no best performer", empty.best, null);
  eq("...and warns about nothing", empty.warnings.length, 0);

  const single = buildPortfolio(
    [trade({ assetId: "stocks:AAPL", tradeNo: "1", rate: 200, qty: 10 })],
    {
      assets: [asset({ id: "stocks:AAPL", price: 250 })],
      fx: FX,
      baseCurrency: "PKR",
    },
  );
  eq("one position is the best", single.best?.assetId, "stocks:AAPL");
  eq("...and there is no worst to contrast it with", single.worst, null);

  // The same book, totalled in USD instead.
  const usd = buildPortfolio(
    [
      trade({ assetId: "psx:LUCK", tradeNo: "1", rate: 150, qty: 100 }),
      trade({ assetId: "stocks:AAPL", tradeNo: "2", rate: 200, qty: 10 }),
    ],
    {
      assets: [
        asset({ id: "psx:LUCK", market: "psx", currency: "PKR", price: 200 }),
        asset({ id: "stocks:AAPL", price: 250 }),
      ],
      fx: FX,
      baseCurrency: "USD",
    },
  );
  eq("the base currency is honoured", usd.totals.baseCurrency, "USD");
  // Rs 20,000 / 277.60 = $72.05, plus $2,500
  near("a PKR position converts down into USD", usd.totals.marketValue, 20000 / 277.6 + 2500, 0.01);
  // In USD the $2,500 Apple position dwarfs the Rs 20,000 one.
  eq("allocation re-sorts under a different base", usd.byAsset[0].key, "stocks:AAPL");
}

/* ------------------------------------------------- fractional quantities */

/**
 * A closed fractional position must disappear, and closing one must not look
 * like an over-sell.
 *
 * `Transaction.qty` is a `Float` so that 0.05 BTC is representable, which means
 * the engine's zero test cannot be exact: `0.1 + 0.2` is 0.30000000000000004, so
 * selling 0.3 leaves 5.55e-17 behind. Untested, that residue is a live holding
 * rendering as "0.00" units, and the mirror ordering warns about an over-sell on
 * a ledger that balances exactly. Both are what `QTY_EPSILON` in `holdings.ts`
 * exists for; neither is visible in a whole-share ledger, which is why this
 * section is here rather than folded into the cases above.
 */
function checkFractionalQuantities() {
  section("Portfolio engine — fractional quantities");

  const assets: PricedAsset[] = [
    asset({ id: "crypto:BTC", market: "crypto", kind: "crypto", price: 100000 }),
  ];
  const btc = (over: Partial<PortfolioTrade>) =>
    trade({ assetId: "crypto:BTC", rate: 80000, ...over });

  // Buy 0.1 then 0.2, sell all 0.3. Held qty is 0.30000000000000004 by then.
  const closed = buildPortfolio(
    [
      btc({ tradeNo: "1", qty: 0.1 }),
      btc({ tradeNo: "2", qty: 0.2 }),
      btc({ tradeNo: "3", qty: 0.3, side: "SELL", rate: 90000 }),
    ],
    { assets, fx: FX, baseCurrency: "USD" },
  );
  eq("a fully-closed fractional position leaves no holding", closed.positions.length, 0);
  eq("closing it raises no warning", closed.warnings.length, 0);
  // 0.3 × (90,000 − 80,000). Booked in full even though the position is gone.
  near("its realized P&L is still booked", closed.realized[0]?.baseAmount, 3000, 0.01);

  // The same trades the other way round: one buy, two sells. After selling 0.1
  // from 0.3 the remainder is 0.19999999999999998, just under the 0.2 sold next.
  const reversed = buildPortfolio(
    [
      btc({ tradeNo: "1", qty: 0.3 }),
      btc({ tradeNo: "2", qty: 0.1, side: "SELL", rate: 90000 }),
      btc({ tradeNo: "3", qty: 0.2, side: "SELL", rate: 90000 }),
    ],
    { assets, fx: FX, baseCurrency: "USD" },
  );
  eq("selling a position off in fractions closes it", reversed.positions.length, 0);
  eq("and is not reported as an over-sell", reversed.warnings.length, 0);

  // The tolerance must not swallow a real position. 2e-8 BTC is dust to a human
  // and two orders of magnitude above QTY_EPSILON.
  const tiny = buildPortfolio([btc({ tradeNo: "1", qty: 0.00000002 })], {
    assets,
    fx: FX,
    baseCurrency: "USD",
  });
  eq("a genuinely tiny holding survives", tiny.positions.length, 1);
  eq("with its quantity intact", tiny.positions[0]?.qty, 0.00000002);

  // And a real over-sell must still be caught.
  const over = buildPortfolio(
    [btc({ tradeNo: "1", qty: 0.5 }), btc({ tradeNo: "2", qty: 0.8, side: "SELL" })],
    { assets, fx: FX, baseCurrency: "USD" },
  );
  eq("a genuine over-sell is still warned about", over.warnings.length, 1);
  ok(
    "and names the asset",
    over.warnings[0]?.includes("crypto:BTC"),
    over.warnings[0] ?? "no warning",
  );
}

/* ------------------------------------------------------------------ run */

function main() {
  checkResolution();
  checkManualEntry();
  checkBaseCurrency();
  checkPortfolio();
  checkDegradedPortfolio();
  checkImpliedPsxCurrency();
  checkRealizedAndSells();
  checkFractionalQuantities();
  checkEmptyAndUsdBase();

  if (failures > 0) {
    console.error(`\nFAILED — ${failures} of ${checks} checks failed.`);
    process.exit(1);
  }
  console.log(`\nPASS — ${checks}/${checks} checks passed.`);
}

main();
