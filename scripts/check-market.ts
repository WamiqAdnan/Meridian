/**
 * Standalone checks for the market layer: the performance windows, the movers
 * engine, currency conversion, every provider's payload parsing, and the
 * registry's routing and fallback behaviour.
 *
 * Run: npm run check:market
 *
 * No network and no database. Provider parsing runs against checked-in fixtures
 * in data/reference/market/ (real captured payloads, trimmed), and the registry
 * is exercised with stub providers injected in place of the real ones. If a
 * change moves one of the frozen numbers below, that's the point.
 */
import { readFileSync } from "node:fs";
import {
  assetId,
  isMarket,
  isNotional,
  parseAssetId,
  MARKETS,
  MARKET_META,
  type AssetRef,
  type BarData,
  type MarketDataProvider,
  type ProviderQuoteResult,
} from "@/lib/markets/types";
import {
  barOnOrBefore,
  computePerformance,
  rankByChange,
  topMovers,
  unusualMove,
} from "@/lib/markets/performance";
import { buildFxTable, convert, isMoney, rate } from "@/lib/markets/currency";
import { parseChartPayload, yahooSymbolFor } from "@/lib/markets/providers/yahoo";
import { parseEodPayload, isPsxIndex } from "@/lib/markets/providers/psx";
import { parseMarketChart, parseMarketsPayload } from "@/lib/markets/providers/coingecko";
import { parseTimeseries, splitPair } from "@/lib/markets/providers/frankfurter";
import { quoteFromBars, mapWithConcurrency } from "@/lib/markets/providers/shared";
import { candidateProviders, fetchAssets } from "@/lib/markets/registry";
import { CATALOGUE } from "@/lib/markets/catalogue";

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

const fixture = (name: string) =>
  JSON.parse(readFileSync(`data/reference/market/${name}`, "utf8"));

/** A minimal asset, for tests that only care about identity. */
function testAsset(over: Partial<AssetRef> = {}): AssetRef {
  return {
    id: "stocks:TEST",
    market: "stocks",
    symbol: "TEST",
    name: "Test",
    kind: "stock",
    currency: "USD",
    source: "yahoo",
    sourceSymbol: "TEST",
    rank: 1,
    benchmark: true,
    ...over,
  };
}

/** Build a daily series from closes, one bar per calendar day ending `endDate`. */
function series(closes: number[], endDate = "2026-08-18", id = "stocks:TEST"): BarData[] {
  const end = new Date(`${endDate}T00:00:00Z`);
  return closes.map((close, i) => {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - (closes.length - 1 - i));
    return {
      assetId: id,
      date: d.toISOString().slice(0, 10),
      open: null,
      high: null,
      low: null,
      close,
      volume: null,
      source: "test",
    };
  });
}

/* ------------------------------------------------------------- taxonomy */

function checkTaxonomy() {
  section("Markets and asset ids");

  eq("every market has metadata", MARKETS.every((m) => MARKET_META[m]?.id === m), true);
  eq("isMarket accepts a known market", isMarket("crypto"), true);
  eq("isMarket rejects an unknown one", isMarket("bananas"), false);
  eq("isMarket rejects a non-string", isMarket(7), false);

  eq("assetId composes", assetId("crypto", "btc"), "crypto:BTC");
  eq("assetId upper-cases the symbol", assetId("psx", "luck"), "psx:LUCK");

  const parsed = parseAssetId("commodities:XAU");
  eq("parseAssetId market", parsed?.market, "commodities");
  eq("parseAssetId symbol", parsed?.symbol, "XAU");
  eq("parseAssetId rejects a bad market", parseAssetId("gold:XAU"), null);
  eq("parseAssetId rejects a missing colon", parseAssetId("XAU"), null);
  eq("parseAssetId rejects an empty symbol", parseAssetId("crypto:"), null);
  eq("parseAssetId rejects an empty market", parseAssetId(":BTC"), null);
  eq("a symbol containing a colon keeps its tail", parseAssetId("stocks:BRK:B")?.symbol, "BRK:B");

  eq("an index is notional", isNotional("index"), true);
  eq("a yield is notional", isNotional("bond_yield"), true);
  eq("a stock is not", isNotional("stock"), false);

  // The catalogue is seed data, so its integrity is worth pinning.
  const ids = new Set(CATALOGUE.map((a) => a.id));
  eq("catalogue ids are unique", ids.size, CATALOGUE.length);
  eq(
    "every catalogue id matches its market and symbol",
    CATALOGUE.every((a) => a.id === assetId(a.market, a.symbol)),
    true,
  );
  eq(
    "every catalogue asset names a provider",
    CATALOGUE.every((a) => a.source.length > 0 && a.sourceSymbol.length > 0),
    true,
  );
  eq(
    "notional assets are never given a real currency",
    CATALOGUE.filter((a) => isNotional(a.kind)).every((a) => !isMoney(a.currency)),
    true,
  );
}

/* ---------------------------------------------------------- performance */

function checkPerformance() {
  section("Performance windows");

  // 40 sessions ending 2026-08-18, rising 100 → 139.
  const rising = series(Array.from({ length: 40 }, (_, i) => 100 + i));
  const perf = computePerformance("stocks:TEST", rising);

  eq("latest close", perf.latest, 139);
  eq("latest date", perf.latestDate, "2026-08-18");
  near("1D change", perf.periods.day?.changePct, (1 / 138) * 100);
  eq("1D reference date", perf.periods.day?.fromDate, "2026-08-17");

  // A week back is 2026-08-11, which closed at 132.
  eq("1W anchors on the bar 7 days back", perf.periods.week?.fromDate, "2026-08-11");
  near("1W change", perf.periods.week?.changePct, ((139 - 132) / 132) * 100);

  // 30 days back is 2026-07-19, which closed at 109.
  eq("1M anchors 30 days back", perf.periods.month?.fromDate, "2026-07-19");
  near("1M change", perf.periods.month?.changePct, ((139 - 109) / 109) * 100);

  ok("3M is absent when the series is too short", perf.periods.quarter === undefined);
  ok("1Y is absent when the series is too short", perf.periods.year === undefined);
  // The series begins 2026-07-10, so there is no bar on or before 1 January to
  // measure from. Refusing to answer is the correct behaviour, not a gap.
  ok("YTD is absent when the series starts mid-year", perf.periods.ytd === undefined);

  // A series that does span the year boundary can answer it.
  const spansNewYear = computePerformance(
    "stocks:TEST",
    series(Array.from({ length: 300 }, (_, i) => 100 + i), "2026-08-18"),
  );
  ok("YTD is present once the series reaches January", spansNewYear.periods.ytd !== undefined);
  eq(
    "YTD anchors on the first session of the year",
    spansNewYear.periods.ytd?.fromDate.slice(0, 4),
    "2026",
  );
  ok(
    "YTD anchors on or before 1 January's successor",
    (spansNewYear.periods.ytd?.fromDate ?? "") <= "2026-01-02",
    spansNewYear.periods.ytd?.fromDate,
  );

  section("Performance edge cases");

  const empty = computePerformance("stocks:TEST", []);
  eq("empty series has no latest", empty.latest, null);
  eq("empty series has no periods", Object.keys(empty.periods).length, 0);

  const single = computePerformance("stocks:TEST", series([100]));
  eq("single bar reports a price", single.latest, 100);
  eq("single bar has no day change", single.periods.day, undefined);

  const zeroRef = computePerformance("stocks:TEST", series([0, 50]));
  eq("a zero reference yields no percentage", zeroRef.periods.day, undefined);

  const flat = computePerformance("stocks:TEST", series([100, 100]));
  near("a flat day is 0%, not null", flat.periods.day?.changePct, 0);

  const falling = computePerformance("stocks:TEST", series([200, 150]));
  near("a fall is negative", falling.periods.day?.changePct, -25);

  section("Locating the reference bar");

  const sparse: BarData[] = [
    { ...series([1])[0], date: "2026-08-03", close: 10 },
    { ...series([1])[0], date: "2026-08-07", close: 20 },
    { ...series([1])[0], date: "2026-08-14", close: 30 },
  ];
  eq("exact date hits", barOnOrBefore(sparse, "2026-08-07")?.close, 20);
  eq("a gap falls back to the prior session", barOnOrBefore(sparse, "2026-08-10")?.close, 20);
  eq("after the last bar returns the last", barOnOrBefore(sparse, "2026-09-01")?.close, 30);
  eq("before the first bar returns null", barOnOrBefore(sparse, "2026-01-01"), null);
  eq("an empty series returns null", barOnOrBefore([], "2026-08-07"), null);

  // A holiday-truncated series must report its last real session, not a fake 0%.
  const stale = computePerformance("stocks:TEST", series([100, 110], "2026-06-30"));
  eq("windows anchor on the latest bar, not today", stale.latestDate, "2026-06-30");
  near("a stale series still reports its day move", stale.periods.day?.changePct, 10);
}

/* --------------------------------------------------------------- movers */

function checkMovers() {
  section("Gainers and losers");

  const assets = [
    { id: "a", symbol: "AAA" },
    { id: "b", symbol: "BBB" },
    { id: "c", symbol: "CCC" },
    { id: "d", symbol: "DDD" },
    { id: "e", symbol: "EEE" },
  ];
  const perf = new Map([
    ["a", computePerformance("a", series([100, 110]))], // +10%
    ["b", computePerformance("b", series([100, 95]))], //  -5%
    ["c", computePerformance("c", series([100, 130]))], // +30%
    ["d", computePerformance("d", series([100, 80]))], //  -20%
    ["e", computePerformance("e", [])], //               no data
  ]);
  const perfOf = (a: { id: string }) => perf.get(a.id);

  const ranked = rankByChange(assets, perfOf, "day");
  eq("assets with no data are dropped, not ranked flat", ranked.length, 4);
  eq("ranked best first", ranked[0].item.symbol, "CCC");
  eq("ranked worst last", ranked[3].item.symbol, "DDD");

  const movers = topMovers(assets, perfOf, "day", 2);
  eq("two gainers", movers.gainers.length, 2);
  eq("best gainer", movers.gainers[0].item.symbol, "CCC");
  eq("second gainer", movers.gainers[1].item.symbol, "AAA");
  eq("two losers", movers.losers.length, 2);
  eq("worst loser first", movers.losers[0].item.symbol, "DDD");
  eq("second loser", movers.losers[1].item.symbol, "BBB");
  ok(
    "no asset appears as both a gainer and a loser",
    movers.gainers.every((g) => !movers.losers.some((l) => l.item.id === g.item.id)),
  );

  // Percentage and absolute are different questions: CCC moves +30 points,
  // DDD moves -20, so CCC leads on both here — but a big-ticket asset would not.
  const abs = topMovers(
    [
      { id: "big", symbol: "BIG" },
      { id: "small", symbol: "SML" },
    ],
    (a) =>
      new Map([
        ["big", computePerformance("big", series([1000, 1050]))], // +5%, +50
        ["small", computePerformance("small", series([10, 12]))], // +20%, +2
      ]).get(a.id),
    "day",
    2,
  );
  eq("percentage ranks the small mover first", abs.gainers[0].item.symbol, "SML");
  eq("absolute ranks the big mover first", abs.biggestAbsolute[0].item.symbol, "BIG");

  const none = topMovers(assets, () => undefined, "day");
  eq("no data means no gainers", none.gainers.length, 0);
  eq("no data means no losers", none.losers.length, 0);
  eq("an empty universe is handled", topMovers([], () => undefined, "day").gainers.length, 0);

  section("Unusual moves");

  // 60 flat-ish sessions then a jump: high deviation, easily flagged.
  const calm = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 === 0 ? 0.1 : -0.1));
  const shocked = unusualMove(series([...calm, 110]));
  ok("a jump after a calm run scores high", (shocked?.zScore ?? 0) > 3, `z=${shocked?.zScore}`);
  near("the flagged move is the latest one", shocked?.changePct, 10, 0.3);

  eq("too short a series is not judged", unusualMove(series([100, 110])), null);
  eq("a perfectly flat series has no deviation", unusualMove(series(Array(80).fill(100))), null);

  const volatile = Array.from({ length: 60 }, (_, i) => 100 * (1 + (i % 2 === 0 ? 0.08 : -0.075)));
  const normalForIt = unusualMove(series([...volatile, volatile.at(-1)! * 1.08]));
  ok(
    "the same % move is unremarkable for a volatile asset",
    normalForIt !== null && Math.abs(normalForIt.zScore) < 3,
    `z=${normalForIt?.zScore}`,
  );
}

/* ------------------------------------------------------------- currency */

function checkCurrency() {
  section("Currency conversion");

  const fx = buildFxTable([
    { symbol: "EURUSD", currency: "USD", price: 1.1574 },
    { symbol: "GBPUSD", currency: "USD", price: 1.3532 },
    { symbol: "USDPKR", currency: "PKR", price: 277.6 },
    { symbol: "USDJPY", currency: "JPY", price: 159.667 },
  ]);

  near("USD is the pivot", fx.get("USD"), 1, 0);
  near("a quote-USD pair is read directly", fx.get("EUR"), 1.1574);
  near("a base-USD pair is inverted", fx.get("PKR"), 1 / 277.6, 1e-9);

  near("USD to PKR", rate("USD", "PKR", fx), 277.6, 0.01);
  near("PKR to USD", rate("PKR", "USD", fx), 1 / 277.6, 1e-9);
  near("EUR to PKR crosses through USD", rate("EUR", "PKR", fx), 1.1574 * 277.6, 0.01);
  near("Rs 277,600 is $1,000", convert(277_600, "PKR", "USD", fx), 1000, 0.01);
  eq("same currency is identity", convert(1234.5, "USD", "USD", fx), 1234.5);
  near("case is ignored", convert(1, "usd", "pkr", fx), 277.6, 0.01);

  // A round trip must not drift, or portfolio totals wobble by currency.
  const roundTrip = convert(convert(50_000, "PKR", "EUR", fx)!, "EUR", "PKR", fx);
  near("a round trip returns the original", roundTrip, 50_000, 0.000001);

  section("Currency refusals");

  eq("an unknown currency yields null", convert(100, "ZWL", "USD", fx), null);
  eq("an unknown target yields null", convert(100, "USD", "ZWL", fx), null);
  eq("index points are not money", convert(100, "PTS", "USD", fx), null);
  eq("a yield is not money", convert(100, "PCT", "USD", fx), null);
  eq("isMoney rejects PTS", isMoney("PTS"), false);
  eq("isMoney accepts PKR", isMoney("PKR"), true);

  const junk = buildFxTable([
    { symbol: "EURUSD", currency: "USD", price: 0 },
    { symbol: "GBPUSD", currency: "USD", price: Number.NaN },
    { symbol: "USDPKR", currency: "PKR", price: -5 },
    { symbol: "TOOLONGSYMBOL", currency: "USD", price: 2 },
    { symbol: "EURGBP", currency: "GBP", price: 0.85 },
  ]);
  eq("a zero rate is ignored", junk.get("EUR"), undefined);
  eq("NaN is ignored", junk.get("GBP"), undefined);
  eq("a negative rate is ignored", junk.get("PKR"), undefined);
  eq("a malformed symbol is ignored", junk.size, 1);
  eq("a cross pair is not chained", junk.get("EURGBP" as string), undefined);
}

/* ------------------------------------------------------------ providers */

function checkYahoo() {
  section("Yahoo payloads");

  const gold = testAsset({ id: "commodities:XAU", market: "commodities", symbol: "XAU", kind: "commodity", sourceSymbol: "GC=F" });
  const parsed = parseChartPayload(gold, fixture("yahoo-gold-chart.json"));

  eq("no error on a good payload", parsed.error, null);
  eq("bars are read", parsed.bars.length, 12);
  eq("bars are tagged with the asset", parsed.bars[0].assetId, "commodities:XAU");
  eq("bars are tagged with the source", parsed.bars[0].source, "yahoo");
  ok(
    "bars are chronological",
    parsed.bars.every((b, i) => i === 0 || b.date >= parsed.bars[i - 1].date),
  );
  ok("a quote is produced", parsed.quote !== null);
  eq("the price is the live one, not the last bar", parsed.quote?.price, 4447.2);
  eq(
    "the previous close is the bar before the latest",
    parsed.quote?.previousClose,
    parsed.bars.at(-2)?.close,
  );

  section("Yahoo malformed payloads");

  eq("an error envelope is reported", parseChartPayload(gold, { chart: { error: { description: "Not Found" } } }).error, "Not Found");
  eq("an empty body is reported", parseChartPayload(gold, {}).error, "No chart result in response.");
  eq("a result with no price is reported", parseChartPayload(gold, { chart: { result: [{ meta: {} }] } }).quote, null);

  const holey = parseChartPayload(gold, {
    chart: {
      result: [
        {
          meta: { regularMarketPrice: 50 },
          timestamp: [1_786_000_000, 1_786_086_400, 1_786_172_800],
          indicators: { quote: [{ close: [10, null, 30] }] },
        },
      ],
    },
  });
  eq("a null close is skipped, not zero-filled", holey.bars.length, 2);
  eq("the surviving bars keep their values", holey.bars.map((b) => b.close).join(","), "10,30");

  const oneBar = parseChartPayload(gold, {
    chart: {
      result: [
        {
          meta: { regularMarketPrice: 50, chartPreviousClose: 48 },
          timestamp: [1_786_000_000],
          indicators: { quote: [{ close: [50] }] },
        },
      ],
    },
  });
  near("with one bar it falls back to chartPreviousClose", oneBar.quote?.previousClose, 48);
  near("and still computes a change", oneBar.quote?.changePct, ((50 - 48) / 48) * 100);

  section("Yahoo symbol mapping");

  eq("a native asset keeps its symbol", yahooSymbolFor(gold), "GC=F");
  eq("crypto maps to a USD pair", yahooSymbolFor(testAsset({ market: "crypto", symbol: "BTC", kind: "crypto", source: "coingecko", sourceSymbol: "bitcoin" })), "BTC-USD");
  eq("a USD-base pair drops the USD", yahooSymbolFor(testAsset({ market: "forex", symbol: "USDPKR", kind: "fx_pair", source: "frankfurter" })), "PKR=X");
  eq("a non-USD-base pair keeps both legs", yahooSymbolFor(testAsset({ market: "forex", symbol: "EURUSD", kind: "fx_pair", source: "frankfurter" })), "EURUSD=X");
  eq("PSX is not on Yahoo", yahooSymbolFor(testAsset({ market: "psx", symbol: "LUCK", source: "psx" })), null);
}

function checkPsx() {
  section("PSX EOD payloads");

  const luck = testAsset({ id: "psx:LUCK", market: "psx", symbol: "LUCK", currency: "PKR", source: "psx", sourceSymbol: "LUCK" });
  const { bars, error } = parseEodPayload(luck, fixture("psx-eod-luck.json"));

  eq("no error on a good payload", error, null);
  eq("all rows are read", bars.length, 15);
  ok(
    "rows arrive newest-first and are re-sorted oldest-first",
    bars.every((b, i) => i === 0 || b.date >= bars[i - 1].date),
  );
  eq("volume is carried through", typeof bars[0].volume, "number");
  eq("bars are tagged psx", bars[0].source, "psx");

  const trimmed = parseEodPayload(luck, fixture("psx-eod-luck.json"), bars.at(-3)!.date);
  eq("a since-date trims the series", trimmed.bars.length, 3);

  section("PSX malformed payloads");

  eq("a failed status is reported", parseEodPayload(luck, { status: 0, message: "nope" }).error, "nope");
  eq("a missing data array is reported", parseEodPayload(luck, { status: 1 }).error, "PSX EOD feed returned no data array.");
  eq("an empty series is reported", parseEodPayload(luck, { status: 1, data: [] }).error, "PSX EOD feed returned no usable rows.");

  const dirty = parseEodPayload(luck, {
    status: 1,
    data: [
      [1_786_964_400, 443.37, 753_981, 448.01],
      [1_786_618_800, null, 696_125],
      ["nonsense", 100, 1],
      [1_786_532_400, 446.47, null],
    ],
  });
  eq("unusable rows are skipped", dirty.bars.length, 2);
  eq("a null volume becomes null, not zero", dirty.bars.find((b) => b.close === 446.47)?.volume, null);

  section("Quotes derived from bars");

  const q = quoteFromBars("psx:LUCK", series([100, 110], "2026-08-18", "psx:LUCK"), "psx");
  eq("price is the newest close", q?.price, 110);
  eq("previous close is the one before", q?.previousClose, 100);
  near("change percent follows", q?.changePct, 10);
  eq("source is recorded", q?.source, "psx");
  eq("no bars means no quote", quoteFromBars("psx:LUCK", [], "psx"), null);

  const single = quoteFromBars("psx:LUCK", series([100], "2026-08-18", "psx:LUCK"), "psx");
  eq("one bar still prices", single?.price, 100);
  eq("one bar has no change", single?.changePct, null);

  eq("KSE100 is an index code", isPsxIndex("KSE100"), true);
  eq("LUCK is not", isPsxIndex("LUCK"), false);
}

function checkCoinGecko() {
  section("CoinGecko payloads");

  const btc = testAsset({ id: "crypto:BTC", market: "crypto", symbol: "BTC", kind: "crypto", source: "coingecko", sourceSymbol: "bitcoin" });
  const eth = testAsset({ id: "crypto:ETH", market: "crypto", symbol: "ETH", kind: "crypto", source: "coingecko", sourceSymbol: "ethereum" });
  const missing = testAsset({ id: "crypto:NOPE", market: "crypto", symbol: "NOPE", kind: "crypto", source: "coingecko", sourceSymbol: "not-a-coin" });

  const quotes = parseMarketsPayload([btc, eth, missing], fixture("coingecko-markets.json"));
  eq("known coins are priced", quotes.size, 2);
  eq("an unlisted coin is simply absent", quotes.has("crypto:NOPE"), false);
  ok("bitcoin has a price", (quotes.get("crypto:BTC")?.price ?? 0) > 0);
  eq("quotes are tagged coingecko", quotes.get("crypto:BTC")?.source, "coingecko");

  // CoinGecko gives a rolling 24h percentage, not a session close, so the
  // reference price is derived from it and must round-trip.
  const q = quotes.get("crypto:BTC")!;
  near(
    "the derived previous close reproduces the percentage",
    ((q.price - q.previousClose!) / q.previousClose!) * 100,
    q.changePct!,
    0.0001,
  );

  const chart = parseMarketChart(btc, fixture("coingecko-chart-btc.json").prices);
  ok("chart points become bars", chart.length > 0);
  ok(
    "one bar per day, chronological",
    chart.every((b, i) => i === 0 || b.date > chart[i - 1].date),
  );
  eq("bars are tagged coingecko", chart[0].source, "coingecko");

  // The series ends with a live point sharing the final day's date.
  const sameDay = parseMarketChart(btc, [
    [Date.UTC(2026, 7, 18, 0, 0), 100],
    [Date.UTC(2026, 7, 18, 8, 0), 105],
  ]);
  eq("two readings on one day collapse to one bar", sameDay.length, 1);
  eq("the later reading wins", sameDay[0].close, 105);

  eq("an empty chart yields no bars", parseMarketChart(btc, []).length, 0);
  eq(
    "non-numeric points are skipped",
    parseMarketChart(btc, [[Number.NaN, 1], [Date.UTC(2026, 7, 18), Number.NaN]] as [number, number][]).length,
    0,
  );
  eq("an empty markets payload prices nothing", parseMarketsPayload([btc], []).size, 0);
  eq(
    "a row without a price is skipped",
    parseMarketsPayload([btc], [{ id: "bitcoin" }]).size,
    0,
  );
}

function checkFrankfurter() {
  section("Frankfurter payloads");

  eq("a supported pair splits", splitPair("EURUSD")?.base, "EUR");
  eq("and keeps the quote leg", splitPair("EURUSD")?.quote, "USD");
  eq("a slash is tolerated", splitPair("EUR/USD")?.quote, "USD");
  eq("PKR is not an ECB currency", splitPair("USDPKR"), null);
  eq("AED is not an ECB currency", splitPair("USDAED"), null);
  eq("a malformed pair is rejected", splitPair("EUR"), null);

  const eur = testAsset({ id: "forex:EURUSD", market: "forex", symbol: "EURUSD", kind: "fx_pair", source: "frankfurter" });
  const bars = parseTimeseries(eur, "USD", {
    rates: {
      "2026-08-14": { USD: 1.15 },
      "2026-08-12": { USD: 1.14 },
      "2026-08-13": { USD: 1.16 },
    },
  });
  eq("all days are read", bars.length, 3);
  eq("and sorted oldest-first", bars.map((b) => b.date).join(","), "2026-08-12,2026-08-13,2026-08-14");
  eq("bars are tagged frankfurter", bars[0].source, "frankfurter");

  eq("a missing currency yields nothing", parseTimeseries(eur, "PKR", { rates: { "2026-08-14": { USD: 1.15 } } }).length, 0);
  eq("an empty payload yields nothing", parseTimeseries(eur, "USD", {}).length, 0);
}

/* ------------------------------------------------------------- registry */

/** A provider that answers exactly as told, without touching the network. */
function stubProvider(
  id: string,
  behaviour: (asset: AssetRef) => Partial<ProviderQuoteResult>,
  opts: { supports?: (a: AssetRef) => boolean; throws?: boolean; calls?: string[] } = {},
): MarketDataProvider {
  return {
    id,
    label: id,
    supports: opts.supports ?? ((a) => a.source === id),
    async fetch(assets) {
      opts.calls?.push(`${id}:${assets.map((a) => a.symbol).join(",")}`);
      if (opts.throws) throw new Error("upstream exploded");
      return assets.map((a) => ({
        assetId: a.id,
        quote: null,
        bars: [],
        error: null,
        ...behaviour(a),
      }));
    },
  };
}

const priced = (a: AssetRef): Partial<ProviderQuoteResult> => ({
  quote: {
    assetId: a.id,
    price: 100,
    previousClose: 99,
    change: 1,
    changePct: 1.0101,
    dayHigh: null,
    dayLow: null,
    volume: null,
    marketTime: null,
    source: "stub",
  },
  bars: series([99, 100], "2026-08-18", a.id),
});

async function checkRegistry() {
  section("Registry routing");

  const good = testAsset({ id: "stocks:GOOD", symbol: "GOOD", source: "alpha" });
  const calls: string[] = [];
  const alpha = stubProvider("alpha", priced, { calls });
  const beta = stubProvider("beta", priced, { supports: () => true, calls });

  const routed = await fetchAssets([good], "1mo", [alpha, beta]);
  eq("the preferred provider answers", routed[0].quote?.price, 100);
  eq("and the fallback is never called", calls.filter((c) => c.startsWith("beta")).length, 0);

  section("Registry fallback");

  const failing = stubProvider("alpha", () => ({ error: "alpha is down" }));
  const rescue = stubProvider("beta", priced, { supports: () => true });
  const rescued = await fetchAssets([good], "1mo", [failing, rescue]);
  eq("a failed provider falls through to the next", rescued[0].quote?.price, 100);
  eq("and the error is cleared", rescued[0].error, null);

  const thrower = stubProvider("alpha", priced, { throws: true });
  const afterThrow = await fetchAssets([good], "1mo", [thrower, rescue]);
  eq("a provider that throws is contained", afterThrow[0].quote?.price, 100);

  const bothDown = await fetchAssets([good], "1mo", [failing, stubProvider("beta", () => ({ error: "beta is down too" }), { supports: () => true })]);
  eq("with everything down, no price is invented", bothDown[0].quote, null);
  ok("and the failure is reported", (bothDown[0].error ?? "").length > 0);

  const orphan = testAsset({ id: "stocks:ORPHAN", symbol: "ORPHAN", source: "nobody" });
  const unroutable = await fetchAssets([orphan], "1mo", [stubProvider("alpha", priced)]);
  eq("an asset no provider supports is not priced", unroutable[0].quote, null);
  ok(
    "and says so",
    (unroutable[0].error ?? "").includes("No provider"),
    unroutable[0].error ?? "",
  );

  section("Registry history fallback");

  // The CoinGecko case: a quote arrives but history does not, so the asset must
  // still fall through to a provider that can supply bars.
  const quoteOnly = stubProvider("alpha", (a) => ({ ...priced(a), bars: [] }));
  const withBars = await fetchAssets([good], "1mo", [quoteOnly, rescue]);
  ok("a quote without history falls through when history was asked for", withBars[0].bars.length > 0);

  const quotesOnlyRequest = await fetchAssets([good], "none", [quoteOnly, rescue]);
  eq("but not when only a quote was asked for", quotesOnlyRequest[0].bars.length, 0);

  section("Registry contract");

  const many = [good, orphan, testAsset({ id: "stocks:X", symbol: "X", source: "alpha" })];
  const all = await fetchAssets(many, "none", [alpha]);
  eq("one result per input asset", all.length, many.length);
  eq(
    "in input order",
    all.map((r) => r.assetId).join(","),
    many.map((a) => a.id).join(","),
  );
  eq("an empty request is fine", (await fetchAssets([], "none", [alpha])).length, 0);

  eq(
    "candidateProviders puts the preferred one first",
    candidateProviders(good, [beta, alpha]).map((p) => p.id).join(","),
    "alpha,beta",
  );
}

async function checkConcurrency() {
  section("Bounded concurrency");

  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 4, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return i * 2;
  });

  eq("every item is processed", out.length, 12);
  eq("results keep input order", out.join(","), items.map((i) => i * 2).join(","));
  ok("the limit is respected", peak <= 4, `peak was ${peak}`);
  eq("an empty list is fine", (await mapWithConcurrency([], 4, async () => 1)).length, 0);
}

/* ------------------------------------------------------------------ run */

async function main() {
  checkTaxonomy();
  checkPerformance();
  checkMovers();
  checkCurrency();
  checkYahoo();
  checkPsx();
  checkCoinGecko();
  checkFrankfurter();
  await checkRegistry();
  await checkConcurrency();

  if (failures > 0) {
    console.error(`\nFAILED — ${failures} of ${checks} checks failed.`);
    process.exit(1);
  }
  console.log(`\nPASS — ${checks}/${checks} checks passed.`);
}

main();
