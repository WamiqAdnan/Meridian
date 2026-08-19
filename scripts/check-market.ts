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
  windowStart,
} from "@/lib/markets/performance";
import {
  MIN_CHART_POINTS,
  axisDateLabel,
  chartWindow,
  niceStep,
  priceScale,
  seriesExtent,
} from "@/lib/markets/chart";
import { buildFxTable, convert, isMoney, rate } from "@/lib/markets/currency";
import { parseChartPayload, yahooSymbolFor, yahooSymbolGuess } from "@/lib/markets/providers/yahoo";
import { parseEodPayload, isPsxIndex } from "@/lib/markets/providers/psx";
import { parseMarketChart, parseMarketsPayload } from "@/lib/markets/providers/coingecko";
import { parseTimeseries, splitPair } from "@/lib/markets/providers/frankfurter";
import { quoteFromBars, mapWithConcurrency } from "@/lib/markets/providers/shared";
import { candidateProviders, fetchAssets } from "@/lib/markets/registry";
import { adoptAsset, normaliseSymbol } from "@/lib/markets/adopt";
import {
  buildMarketViews,
  marketChange,
  marketMove,
  type AssetView,
  type MarketView,
} from "@/lib/markets/view";
import { fmtMove, fmtPct } from "@/lib/format";
import { CATALOGUE } from "@/lib/markets/catalogue";
import { catalogueDrift, daysBefore, type StoredDescription } from "@/lib/markets/store";

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

  // What seedCatalogue decides to write. It used to count ids and skip when they
  // were all present, which is every boot after the first — so the update path,
  // and the rename it exists to apply, could never run.
  const sample = CATALOGUE.slice(0, 3);
  const stored = (a: AssetRef, over: Partial<StoredDescription> = {}): StoredDescription => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    currency: a.currency,
    source: a.source,
    sourceSymbol: a.sourceSymbol,
    rank: a.rank,
    benchmark: true,
    ...over,
  });
  const drift = (over: Partial<StoredDescription>) =>
    catalogueDrift(sample.map((a, i) => (i === 0 ? stored(a, over) : stored(a))), sample);

  eq("a table in sync drifts nothing", catalogueDrift(sample.map((a) => stored(a)), sample).length, 0);
  eq(
    "the real catalogue, faithfully stored, drifts nothing",
    catalogueDrift(CATALOGUE.map((a) => stored(a))).length,
    0,
  );
  eq("a missing row drifts", catalogueDrift(sample.slice(1).map((a) => stored(a)), sample).length, 1);
  eq("a renamed instrument drifts", drift({ name: "Renamed Plc" }).length, 1);
  eq("a corrected provider symbol drifts", drift({ sourceSymbol: "NEW.SYM" }).length, 1);
  eq("a re-pointed provider drifts", drift({ source: "somewhere-else" }).length, 1);
  eq("a re-ranked asset drifts", drift({ rank: 999 }).length, 1);
  eq("a changed currency drifts", drift({ currency: "ZZZ" }).length, 1);
  eq(
    "a changed kind drifts",
    drift({ kind: sample[0].kind === "stock" ? "index" : "stock" }).length,
    1,
  );
  eq("a seeded asset that lost its benchmark flag drifts", drift({ benchmark: false }).length, 1);
  eq("and it is the drifted entry that comes back", drift({ name: "Renamed Plc" })[0].id, sample[0].id);

  // How far back a bar window starts when it is anchored on a past date rather
  // than on today — what makes a series readable as of a week that has closed.
  eq("a window counts back in whole days", daysBefore("2026-08-18", 7), "2026-08-11");
  eq("…across a month boundary", daysBefore("2026-08-03", 7), "2026-07-27");
  eq("…across a year boundary", daysBefore("2026-01-02", 7), "2025-12-26");
  eq("…and over a leap day", daysBefore("2028-03-01", 1), "2028-02-29");
  eq("zero days is the day itself", daysBefore("2026-08-18", 0), "2026-08-18");
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

/* ---------------------------------------------------------------- charts */

function checkChart() {
  section("Window arithmetic");

  eq("a day has no calendar start", windowStart("2026-08-18", "day"), null);
  eq("a week is seven days back", windowStart("2026-08-18", "week"), "2026-08-11");
  eq("a month is thirty days back", windowStart("2026-08-18", "month"), "2026-07-19");
  eq("a quarter is ninety-one days back", windowStart("2026-08-18", "quarter"), "2026-05-19");
  eq("a year is 365 days back", windowStart("2026-08-18", "year"), "2025-08-18");
  eq("YTD is the first of January", windowStart("2026-08-18", "ytd"), "2026-01-01");
  eq("a window crosses a month boundary", windowStart("2026-03-05", "week"), "2026-02-26");
  eq("…and a leap day", windowStart("2024-03-05", "week"), "2024-02-27");
  eq("…and a year boundary", windowStart("2026-01-03", "week"), "2025-12-27");

  section("Axis steps");

  eq("a step of one stays one", niceStep(1), 1);
  eq("just under one rounds up to one", niceStep(0.9), 1);
  eq("1.5 becomes 2", niceStep(1.5), 2);
  eq("2.3 becomes 2.5", niceStep(2.3), 2.5);
  eq("3 becomes 5", niceStep(3), 5);
  eq("7 becomes 10", niceStep(7), 10);
  eq("12 becomes 20", niceStep(12), 20);
  eq("small intervals keep their magnitude", niceStep(0.012), 0.02);
  eq("a zero interval is not divided by", niceStep(0), 1);
  eq("a negative interval is refused", niceStep(-5), 1);
  eq("NaN is refused", niceStep(NaN), 1);
  eq("Infinity is refused", niceStep(Infinity), 1);

  section("Price scale");

  eq("nothing to scale gives no scale", priceScale([]), null);
  eq("non-finite values are not scaled", priceScale([NaN, Infinity]), null);

  const equity = priceScale(Array.from({ length: 40 }, (_, i) => 100 + i));
  eq("an equity range lands on round hundreds", equity?.ticks.join(","), "100,110,120,130,140");
  eq("the axis bottom is the first tick", equity?.min, 100);
  eq("the axis top is the last tick", equity?.max, 140);

  const index = priceScale([7700.12, 7812.55]);
  eq("a five-figure index labels in fifties", index?.ticks.join(","), "7700,7750,7800,7850");
  ok("…covering the low", (index?.min ?? 0) <= 7700.12);
  ok("…and the high", (index?.max ?? 0) >= 7812.55);

  // A yield moves in hundredths of a percent. The float noise that
  // `min + i * step` accumulates would print 4.650000000000001 on the axis.
  const yieldScale = priceScale([4.6, 4.72]);
  eq("a yield labels in clean fractions", yieldScale?.ticks.join(","), "4.6,4.65,4.7,4.75");

  const spanningZero = priceScale([-3, 5]);
  eq("a range spanning zero includes it", spanningZero?.ticks.join(","), "-4,-2,0,2,4,6");

  const flat = priceScale([100, 100, 100]);
  ok("a flat series still gets an axis", flat != null);
  ok("…opened below the value", (flat?.min ?? 0) < 100);
  ok("…and above it", (flat?.max ?? 0) > 100);
  const flatZero = priceScale([0, 0]);
  ok("a flat series at zero does not divide by zero", flatZero != null);
  ok("…and brackets zero", (flatZero?.min ?? 1) < 0 && (flatZero?.max ?? -1) > 0);

  const single = priceScale([100]);
  ok("one value is treated as flat", single != null);
  ok("…and still covers it", (single?.min ?? 0) <= 100 && (single?.max ?? 0) >= 100);

  for (const scale of [equity, index, yieldScale, spanningZero, flat]) {
    ok(
      "ticks ascend",
      scale != null && scale.ticks.every((t, i) => i === 0 || t > scale.ticks[i - 1]),
    );
    ok("ticks start at the minimum", scale?.ticks[0] === scale?.min);
    ok("ticks end at the maximum", scale?.ticks[scale.ticks.length - 1] === scale?.max);
    ok(
      "a readable number of ticks",
      (scale?.ticks.length ?? 0) >= 2 && (scale?.ticks.length ?? 0) <= 9,
      `${scale?.ticks.length} ticks`,
    );
  }

  section("Chart windows");

  const forty = series(Array.from({ length: 40 }, (_, i) => 100 + i));

  eq("an empty series draws nothing", chartWindow([], "week").bars.length, 0);
  ok("…and says so", chartWindow([], "week").exact === false);

  // 7 days back from 2026-08-18 is 2026-08-11, and the series is dense, so the
  // reference session is that very bar: 08-11 through 08-18 inclusive.
  const week = chartWindow(forty, "week");
  eq("a week draws its own window", week.bars.length, 8);
  eq("…anchored on the reference session", week.bars[0].date, "2026-08-11");
  ok("…exactly", week.exact);

  // 30 days back is 2026-07-19.
  const month = chartWindow(forty, "month");
  eq("a month draws its own window", month.bars.length, 31);
  eq("…anchored on the reference session", month.bars[0].date, "2026-07-19");
  ok("…exactly", month.exact);

  const day = chartWindow(forty, "day");
  eq("a day has no window, so recent sessions stand in", day.bars.length, MIN_CHART_POINTS);
  ok("…and it does not claim to be the window", day.exact === false);

  const year = chartWindow(forty, "year");
  eq("a year takes everything there is", year.bars.length, 40);
  ok("…and that is still the window", year.exact);

  eq(
    "a series shorter than the window is drawn whole",
    chartWindow(series([1, 2, 3]), "week").bars.length,
    3,
  );
  eq("a single bar cannot be a line", chartWindow(series([1]), "week").bars.length, 1);
  ok("…so it is not the window", chartWindow(series([1]), "week").exact === false);

  // The reference session is the point of all this: on a market that does not
  // trade every day the window start lands in a gap, and the bar the percentage
  // was measured *from* sits before it. Drawing from inside the window instead
  // spans a different move, and the two can disagree about its direction.
  const gappy: BarData[] = [
    { ...series([1])[0], date: "2026-08-04", close: 100 },
    { ...series([1])[0], date: "2026-08-07", close: 120 },
    { ...series([1])[0], date: "2026-08-14", close: 110 },
    { ...series([1])[0], date: "2026-08-18", close: 118 },
  ];
  const gapWeek = chartWindow(gappy, "week");
  ok(
    "a window opening in a gap starts on the prior session",
    gapWeek.bars[0].date <= "2026-08-11",
    gapWeek.bars[0].date,
  );
  eq("…which is the bar the change is measured from", gapWeek.bars[0].date, "2026-08-07");
  eq(
    "…the same bar computePerformance anchors on",
    computePerformance("stocks:TEST", gappy).periods.week?.fromDate,
    gapWeek.bars[0].date,
  );
  eq(
    "…so the chart and the percentage agree on the open",
    seriesExtent(gapWeek.bars)?.first,
    computePerformance("stocks:TEST", gappy).periods.week?.from,
  );

  const drawn = week.bars;
  eq("the window ends on the latest bar", drawn[drawn.length - 1].date, "2026-08-18");
  ok("the window stays oldest-first", drawn[0].date < drawn[drawn.length - 1].date);
  ok("the window never invents bars", drawn.length <= forty.length);

  section("Series extent");

  eq("an empty series has no extent", seriesExtent([]), null);

  const extent = seriesExtent(series([100, 120, 90, 110]));
  eq("the open is the first close", extent?.first, 100);
  eq("the close is the last close", extent?.last, 110);
  eq("the high is the highest close", extent?.high, 120);
  eq("the low is the lowest close", extent?.low, 90);
  eq("sessions are counted", extent?.sessions, 4);
  eq("the window ends on the last bar", extent?.to, "2026-08-18");
  eq("…and starts on the first", extent?.from, "2026-08-15");
  near("the move is measured across what was drawn", extent?.changePct, 10);

  const oneBar = seriesExtent(series([42]));
  eq("one bar opens and closes at the same price", oneBar?.first, oneBar?.last);
  near("…and has not moved", oneBar?.changePct, 0);

  eq("a zero open yields no percentage", seriesExtent(series([0, 50]))?.changePct, null);
}

function checkAxisDates() {
  section("Axis date labels");

  // Node re-reads `TZ` at runtime. The zone is stated rather than inherited
  // because the bug is invisible from Pakistan: PKT is UTC+5, so a midnight-UTC
  // instant is still the same calendar day here and every label comes out right.
  const before = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    eq("a bar's date labels as its own day, west of UTC", axisDateLabel("2026-08-12", false), "12 Aug");
    eq("with the year when the window spans two", axisDateLabel("2025-12-31", true), "31 Dec 25");
    process.env.TZ = "Asia/Karachi";
    eq("and the same day east of it", axisDateLabel("2026-08-12", false), "12 Aug");
    eq("year included there too", axisDateLabel("2025-12-31", true), "31 Dec 25");
    process.env.TZ = "Pacific/Kiritimati";
    eq("and at UTC+14", axisDateLabel("2026-01-01", false), "1 Jan");
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
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

/* ------------------------------------------------------ market summaries */

/** An asset view: a ref, a quote's worth of fields, and a computed performance. */
function testView(over: Partial<AssetRef>, closes: number[]): AssetView {
  const ref = testAsset(over);
  const bars = series(closes, "2026-08-18", ref.id);
  return {
    ...ref,
    price: bars.at(-1)?.close ?? null,
    previousClose: bars.at(-2)?.close ?? null,
    change: null,
    changePct: null,
    volume: null,
    quoteSource: "test",
    fetchedAt: null,
    marketTime: null,
    performance: computePerformance(ref.id, bars),
    spark: bars.map((b) => b.close),
  };
}

/**
 * The bonds market in miniature, with the shape that matters: five yields quoted
 * in percent, six ETFs quoted in dollars, and `bonds:US10Y` as the headline. The
 * yields are notional, so the median is computed across the ETFs alone.
 */
function bondsMarket(yieldCloses: number[], etfCloses: number[]): MarketView {
  const yields = ["US10Y", "US2Y", "US5Y", "US30Y", "US3M"].map((symbol, i) =>
    testView(
      { id: `bonds:${symbol}`, market: "bonds", symbol, name: symbol, kind: "bond_yield", currency: "PCT" },
      yieldCloses.map((c) => c + i * 0.1),
    ),
  );
  const etfs = ["TLT", "IEF", "SHY", "AGG", "LQD", "HYG"].map((symbol, i) =>
    testView(
      { id: `bonds:${symbol}`, market: "bonds", symbol, name: symbol, kind: "etf", currency: "USD" },
      etfCloses.map((c) => c + i),
    ),
  );
  const [view] = buildMarketViews([...yields, ...etfs], "week");
  return view;
}

/** A month of closes drifting upward, enough for every window a week needs. */
const MONTH = Array.from({ length: 30 }, (_, i) => 90 + i * 0.4);

function checkMarketMove() {
  section("A market's move, and the unit it is read in");

  const full = bondsMarket(
    Array.from({ length: 30 }, (_, i) => 4.2 + i * 0.02),
    MONTH,
  );
  const headline = marketMove(full, "week");
  eq("the headline supplies the move when it has the window", headline.median, false);
  eq("in the headline's own unit", headline.currency, "PCT");
  ok("with the absolute change basis points are computed from", headline.change != null);
  eq(
    "so a yield move reads as basis points",
    fmtMove(headline.changePct, headline.change, headline.currency),
    "+14 bps",
  );

  // A yield whose backfill failed has two bars while the ETFs beside it have a
  // month — the shape `RefreshRun.assetsFail` exists to record. The market still
  // has a median; the headline has no week.
  const gapped = bondsMarket([4.6, 4.72], MONTH);
  const median = marketMove(gapped, "week");
  eq("falls back to the median when the headline has no window", median.median, true);
  ok("and the median is a real number", median.changePct != null);
  ok("which the headline never supplied an absolute change for", median.change == null);
  ok("so the move cannot be read in the headline's basis points", median.currency !== "PCT");
  eq(
    "a median is a percentage, and renders as one",
    fmtMove(median.changePct, median.change, median.currency),
    fmtPct(median.changePct),
  );
  ok(
    "never as a dash over a median it had computed",
    fmtMove(median.changePct, median.change, median.currency) !== "—",
  );

  eq("marketChange still answers the headline's number", marketChange(full, "week"), headline.changePct);
  eq("and still falls back to the same median", marketChange(gapped, "week"), median.changePct);

  // Nothing in the market has a week: an honest dash, not a zero.
  const bare = bondsMarket([4.6, 4.72], [90, 90.4]);
  const nothing = marketMove(bare, "week");
  eq("no window anywhere leaves the move null", nothing.changePct, null);
  eq("still on the median path", nothing.median, true);
  eq("and renders as a dash", fmtMove(nothing.changePct, nothing.change, nothing.currency), "—");
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

  // The guess is what `POST /api/assets` stores as a new row's `sourceSymbol`,
  // and `yahooSymbolFor` trusts that verbatim forever after — so the guess has
  // to be right at write time. It answers from the vocabulary alone, ignoring
  // whatever `source`/`sourceSymbol` the ref happens to carry.
  eq(
    "the guess ignores a source of yahoo instead of short-circuiting on it",
    yahooSymbolGuess({ market: "forex", symbol: "USDSAR", kind: "fx_pair" }),
    "SAR=X",
  );
  eq(
    "yahooSymbolFor would have echoed the bare ticker back",
    yahooSymbolFor(testAsset({ market: "forex", symbol: "USDSAR", kind: "fx_pair", source: "yahoo", sourceSymbol: "USDSAR" })),
    "USDSAR",
  );
  eq("the guess maps a coin", yahooSymbolGuess({ market: "crypto", symbol: "BTC", kind: "crypto" }), "BTC-USD");
  eq("the guess drops a USD base", yahooSymbolGuess({ market: "forex", symbol: "USDPKR", kind: "fx_pair" }), "PKR=X");
  eq("the guess keeps both legs of a cross", yahooSymbolGuess({ market: "forex", symbol: "GBPJPY", kind: "fx_pair" }), "GBPJPY=X");
  eq("the guess normalises a slashed pair", yahooSymbolGuess({ market: "forex", symbol: "USD/PKR", kind: "fx_pair" }), "PKR=X");
  eq("the guess declines PSX", yahooSymbolGuess({ market: "psx", symbol: "LUCK", kind: "stock" }), null);
  eq("the guess declines a pair that is not six letters", yahooSymbolGuess({ market: "forex", symbol: "DXY", kind: "fx_pair" }), null);
  eq("the guess has no opinion on a plain equity", yahooSymbolGuess({ market: "stocks", symbol: "ORCL", kind: "stock" }), null);
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

  // The case with no fallback available: the partial result must survive rather
  // than be replaced by a null one on the way out.
  const noFallback = await fetchAssets([good], "1mo", [quoteOnly]);
  eq("a quote with no history survives when nothing can supply bars", noFallback[0].quote?.price, 100);
  eq("and its bars stay empty", noFallback[0].bars.length, 0);

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

function checkAdopt() {
  section("Adopting a user-added asset");

  // `POST /api/assets` is the only writer to the Asset table that is not the
  // hand-verified catalogue, so it is the only place these columns can go wrong.
  const good = adoptAsset({ market: "stocks", symbol: "ORCL", name: "Oracle" });
  ok("a plain equity is accepted", good.ok);
  if (good.ok) {
    eq("id is market-qualified", good.ref.id, "stocks:ORCL");
    eq("kind falls back to the market default", good.ref.kind, "stock");
    eq("currency falls back to the market default", good.ref.currency, "USD");
    eq("source falls back to the market default", good.ref.source, "yahoo");
    eq("a plain ticker is its own Yahoo symbol", good.ref.sourceSymbol, "ORCL");
    eq("a held asset is not a benchmark", good.ref.benchmark, false);
  }

  const coin = adoptAsset({ market: "crypto", symbol: "matic" });
  eq("a coin gets Yahoo's pair form", coin.ok && coin.ref.sourceSymbol, "MATIC-USD");
  eq("a lowercase ticker is upper-cased", coin.ok && coin.ref.symbol, "MATIC");
  eq("name defaults to the ticker", coin.ok && coin.ref.name, "MATIC");

  const pair = adoptAsset({ market: "forex", symbol: "USDSAR" });
  eq("a USD-base pair gets Yahoo's short form", pair.ok && pair.ref.sourceSymbol, "SAR=X");

  // A pair is quoted in its second leg. `market: "forex"` alone cannot say which
  // currency that is, and the catalogue has agreed on the rule for all ten of
  // its pairs since it was written down.
  eq("a USD-base pair is quoted in the other leg", pair.ok && pair.ref.currency, "SAR");
  eq(
    "a USD-quote pair is quoted in USD",
    (() => { const r = adoptAsset({ market: "forex", symbol: "NZDUSD" }); return r.ok && r.ref.currency; })(),
    "USD",
  );
  eq(
    "a cross is quoted in its second leg",
    (() => { const r = adoptAsset({ market: "forex", symbol: "GBPJPY" }); return r.ok && r.ref.currency; })(),
    "JPY",
  );
  eq(
    "a forex asset that is not a pair keeps the market default",
    (() => { const r = adoptAsset({ market: "forex", symbol: "DXY", kind: "index" }); return r.ok && r.ref.currency; })(),
    "PTS",
  );
  ok(
    "an explicit currency still wins",
    (() => { const r = adoptAsset({ market: "forex", symbol: "USDSAR", currency: "USD" }); return r.ok && r.ref.currency === "USD"; })(),
  );

  // The whole catalogue agrees with the rule, so the user-added path and the
  // seeded path can no longer disagree about what an asset is priced in.
  const disagreed = CATALOGUE.filter((entry) => {
    const derived = adoptAsset({ market: entry.market, symbol: entry.symbol, kind: entry.kind });
    return !derived.ok || derived.ref.currency !== entry.currency;
  });
  ok(
    `every catalogue row's currency follows from its kind (${CATALOGUE.length} rows)`,
    disagreed.length === 0,
    disagreed.map((e) => e.id).join(", "),
  );

  const explicit = adoptAsset({ market: "forex", symbol: "USDSAR", sourceSymbol: "USDSAR=X" });
  eq("an explicit sourceSymbol wins over the guess", explicit.ok && explicit.ref.sourceSymbol, "USDSAR=X");

  // Rejections. Each of these used to be written down verbatim and discovered
  // later as a wrong number, a mis-formatted price, or a dead provider route.
  const badKind = adoptAsset({ market: "stocks", symbol: "PLTR", kind: "not-a-kind" });
  ok("an unknown kind is refused", !badKind.ok);
  ok(
    "the refusal names the kinds that exist",
    !badKind.ok && badKind.error.includes("bond_yield"),
    !badKind.ok ? badKind.error : undefined,
  );
  ok(
    "a known kind the market did not default to is still allowed",
    adoptAsset({ market: "stocks", symbol: "SPY", kind: "etf" }).ok,
  );

  const badCurrency = adoptAsset({ market: "crypto", symbol: "SHIB", currency: "BOGUS" });
  ok("a currency that is not a code is refused", !badCurrency.ok);
  ok("the notional codes are still codes", adoptAsset({ market: "indices", symbol: "SPX" }).ok);
  eq(
    "a lowercase currency is accepted and upper-cased",
    (() => { const r = adoptAsset({ market: "stocks", symbol: "ORCL", currency: "eur" }); return r.ok && r.ref.currency; })(),
    "EUR",
  );

  const badSource = adoptAsset({ market: "stocks", symbol: "SNOW", source: "made-up" });
  ok("an unregistered source is refused", !badSource.ok);
  ok(
    "the refusal lists the providers that exist",
    !badSource.ok && badSource.error.includes("frankfurter"),
    !badSource.ok ? badSource.error : undefined,
  );
  ok(
    "the registry is injectable, so the check does not depend on the real one",
    !adoptAsset({ market: "stocks", symbol: "ORCL" }, [stubProvider("alpha", priced)]).ok,
  );

  ok("an unknown market is refused", !adoptAsset({ market: "tulips", symbol: "X" }).ok);
  ok("a missing ticker is refused", !adoptAsset({ market: "stocks" }).ok);
  ok("a non-string ticker is refused", !adoptAsset({ market: "stocks", symbol: 42 }).ok);
  ok("a ticker of punctuation is refused", !adoptAsset({ market: "stocks", symbol: "!!!" }).ok);

  // A slash would split `forex:USD/PKR` across two path segments, and
  // `assetHref` puts an id in a URL path unescaped on purpose.
  eq("a slash is normalised out of a ticker", normaliseSymbol("usd/pkr"), "USDPKR");
  const slashed = adoptAsset({ market: "forex", symbol: "USD/PKR" });
  eq("the slashed pair resolves to the catalogue's id", slashed.ok && slashed.ref.id, "forex:USDPKR");
  ok("no accepted id can contain a slash", slashed.ok && !slashed.ref.id.includes("/"));
  eq("and it still gets the right Yahoo symbol", slashed.ok && slashed.ref.sourceSymbol, "PKR=X");
  ok("a ticker that is only a slash is refused", !adoptAsset({ market: "forex", symbol: "/" }).ok);

}

async function main() {
  checkTaxonomy();
  checkAdopt();
  checkPerformance();
  checkChart();
  checkAxisDates();
  checkMovers();
  checkMarketMove();
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
