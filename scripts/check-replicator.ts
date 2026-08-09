/**
 * Standalone checks for the index replicator: the fee model, the whole-share
 * allocation, the paste parser, and the edge cases that make a plan unbuyable.
 *
 * Run: npm run check:replicator
 *
 * Fixture is data/reference/kse30-paste.txt — a real KSE30 constituents paste.
 * The frozen totals below were computed once from that fixture; if a change to the
 * engine moves them, that's the point.
 */
import { readFileSync } from "node:fs";
import { parsePsxTable } from "@/lib/parse-psx-table";
import { INDEX_OPTIONS, isIndexCode, parseConstituentsTable } from "@/lib/psx-index";
import {
  DEFAULT_FEE_SCHEDULE,
  planReplication,
  tradeCdcFee,
  tradeCommission,
  type Constituent,
  type ReplicationPlan,
  type ReplicationResult,
} from "@/lib/replicator";

const F = DEFAULT_FEE_SCHEDULE;

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

function near(label: string, actual: number, expected: number, tol = 0.005) {
  ok(label, Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected} ±${tol}`);
}

function section(name: string) {
  console.log(`\n${name}`);
}

/** Unwrap a plan we expect to succeed. */
function must(label: string, result: ReplicationResult): ReplicationPlan {
  if (result.ok) return result;
  failures++;
  checks++;
  console.error(`  FAIL  ${label} — expected a plan, got error: ${result.error}`);
  process.exit(1);
}

// ---------------------------------------------------------------- fee model (§5)

section("Fee model");

// The spec's own arithmetic, independent of any basket.
near("commission is 0.25% of trade value", tradeCommission(296298, 545, 543, F), 740.745);
near("16 small trades hit the CDC floor", 16 * tradeCdcFee(38695, F), 80);
near("CDC floor applies below the crossover", tradeCdcFee(1000, F), 5);
near("CDC % applies above the crossover", tradeCdcFee(200000, F), 7.2);
near("penny stocks pay per share, not per cent", tradeCommission(800, 8, 100, F), 3);
near("new-account setup", F.setupOneTime + F.setupAnnual, 923.15);

// ------------------------------------------------------------- paste parser (§3)

section("Paste parser");

const fixture = readFileSync("data/reference/kse30-paste.txt", "utf8");
const parsed = parsePsxTable(fixture);

eq("reads every row of the fixture", parsed.rows.length, 25);
eq("skips nothing in a clean paste", parsed.skipped.length, 0);
near("sums the pasted weights", parsed.totalWeight, 84.93, 0.005);

const ffc = parsed.rows.find((r) => r.symbol === "FFC");
ok("finds FFC", ffc != null);
eq("takes price from CURRENT, not LDCP", ffc?.price, 545);
eq("keeps LDCP separately", ffc?.ldcp, 543.22);
eq("takes weight from IDX WTG (%)", ffc?.weight, 11.89);
eq("keeps the name with its spaces", ffc?.name, "Fauji Fertilizer Company Limited");

const negative = parsed.rows.find((r) => r.symbol === "PRL");
eq("a negative change doesn't derail the columns", negative?.price, 41.81);
eq("…and its weight still reads", negative?.weight, 0.39);

const odd = parsePsxTable(
  [
    "SYMBOL NAME LDCP CURRENT CHANGE CHANGE (%) IDX WTG (%) IDX POINT VOLUME FREEFLOAT (M) MARKET CAP (M)",
    "FFCXD Fauji Fertilizer Company Limited 552.88 552.96 0.08 0.01% 12.12% 20.00 100,000 566 308,331",
    "SSGC Sui Southern Gas Company Limited 28.38 - - - 0.39% - - 356 10,152",
    "MEBL 538.00 9.88",
    "FFC Fauji Fertilizer Company Limited 543.22 545.00 1.78 0.33% 11.89% 93.09 940,148 566 308,331",
    "FFC Fauji Fertilizer Company Limited 543.22 545.00 1.78 0.33% 11.89% 93.09 940,148 566 308,331",
    "total records: 30",
  ].join("\n"),
);
eq("ignores the header row", odd.rows.some((r) => r.symbol === "SYMBOL"), false);
eq("keeps the ex-dividend ticker as published", odd.rows[0].symbol, "FFCXD");
eq("…and maps it to the base symbol", odd.rows[0].baseSymbol, "FFC");
eq("a blank price cell parses as no price", odd.rows[1].price, null);
eq("…while the row's weight survives", odd.rows[1].weight, 0.39);
eq("accepts a hand-typed SYMBOL price weight", odd.rows[2].price, 538);
eq("…with its weight", odd.rows[2].weight, 9.88);
eq("reports a duplicate instead of double-counting", odd.skipped.length, 2);
ok(
  "…naming the duplicate",
  odd.skipped.some((s) => s.reason.includes("FFC appears more than once")),
);
ok(
  "…and the unreadable line",
  odd.skipped.some((s) => s.line.startsWith("total records")),
);

// ------------------------------------------------------- live index fragment parser

section("Index fragment parser");

// A real /indices/KSE30 response, frozen so these checks never touch the network.
const fragment = parseConstituentsTable(
  readFileSync("data/reference/kse30-indices-fragment.html", "utf8"),
);

eq("reads all 30 constituents", fragment.length, 30);
near(
  "published weights account for the whole index",
  fragment.reduce((s, r) => s + (r.weight ?? 0), 0),
  100,
  0.05,
);
ok("every row carries a price", fragment.every((r) => r.price != null && r.price > 0));
ok("every row carries a weight", fragment.every((r) => r.weight != null));

const airlink = fragment.find((r) => r.symbol === "AIRLINK");
eq("takes CURRENT, not LDCP (135.69)", airlink?.price, 135.86);
eq("takes IDX WTG", airlink?.weight, 0.45);
eq("keeps the company name", airlink?.name, "Air Link Communication Limited");

// Ex-dividend tickers only appear during a name's XD window, so the fixture may or may
// not hold any. On a clean day nothing should be rewritten.
ok(
  "leaves ordinary symbols untouched",
  fragment.every((r) => !/(XD|XB|XR)$/.test(r.symbol) === (r.baseSymbol === r.symbol)),
);

const xdWindow = parseConstituentsTable(`
  <table>
    <thead><tr><th>SYMBOL</th><th>NAME</th><th>LDCP</th><th>CURRENT</th><th>IDX WTG (%)</th></tr></thead>
    <tbody>
      <tr><td data-order="FFCXD"><strong>FFCXD</strong></td><td>Fauji Fertilizer Company Limited</td>
          <td>552.88</td><td data-order="552.96">552.96</td><td>12.12%</td></tr>
      <tr><td data-order="EFERTXD"><strong>EFERTXD</strong></td><td>Engro Fertilizers Limited</td>
          <td>185.90</td><td data-order="186.07">186.07</td><td>3.10%</td></tr>
    </tbody>
  </table>
`);
eq("keeps an ex-dividend ticker as published", xdWindow[0].symbol, "FFCXD");
eq("…and maps it to the ledger's symbol", xdWindow[0].baseSymbol, "FFC");
eq("…for every such row", xdWindow[1].baseSymbol, "EFERT");

// Columns are located by header text, so the portal can reorder them without breaking us.
const shuffled = parseConstituentsTable(`
  <table>
    <thead><tr><th>IDX WTG (%)</th><th>NAME</th><th>CURRENT</th><th>SYMBOL</th><th>LDCP</th></tr></thead>
    <tbody><tr>
      <td>7.32%</td><td>Meezan Bank Limited</td>
      <td data-order="587.28">587.28</td><td data-order="MEBL"><strong>MEBL</strong></td>
      <td data-order="580.10">580.10</td>
    </tr></tbody>
  </table>
`);
eq("survives reordered columns — symbol", shuffled[0]?.symbol, "MEBL");
eq("…price", shuffled[0]?.price, 587.28);
eq("…weight", shuffled[0]?.weight, 7.32);

let layoutRejected = false;
try {
  parseConstituentsTable("<table><thead><tr><th>SYMBOL</th><th>VOLUME</th></tr></thead></table>");
} catch {
  layoutRejected = true;
}
ok("refuses a layout with no price or weight column", layoutRejected);

// The index code is an allow-list, so a request parameter can't steer the upstream fetch.
ok("accepts a known index code", isIndexCode("KSE30"));
eq("rejects an unknown code", isIndexCode("KSE31"), false);
eq("rejects a path-traversal attempt", isIndexCode("../market-watch"), false);
eq("rejects an absolute URL", isIndexCode("https://example.com/x"), false);
ok("every offered index has a label and a code", INDEX_OPTIONS.every((o) => !!o.code && !!o.label));

// ------------------------------------------------------------------ engine (§4)

section("Allocation");

const toConstituents = (rows: typeof parsed.rows): Constituent[] =>
  rows.map((r) => ({ symbol: r.symbol, name: r.name, price: r.price!, weight: r.weight! }));

const HELD = ["DGKC", "ENGROH", "FCCL", "FFC", "HUBC", "LUCK", "MEBL", "MLCF", "OGDC", "PPL", "PSO", "SYS"];
const held = toConstituents(parsed.rows.filter((r) => HELD.includes(r.baseSymbol)));
eq("the fixture covers 12 held names", held.length, 12);

const all25 = must("all 25 @ 300k", planReplication({ amount: 300000, constituents: toConstituents(parsed.rows) }));
near("invested", all25.invested, 297106.06);
near("commission", all25.fees.commission, 742.77);
near("CDC — 25 trades at the floor", all25.fees.cdcTxn, 125);
near("fees", all25.fees.total, 867.77);
near("grand total", all25.grandTotal, 297973.83);
near("buffer", all25.buffer, 2026.17);
eq("trade count", all25.tradeCount, 25);
eq("no zero-share rows at this size", all25.rows.filter((r) => r.shares === 0).length, 0);

const plan300k = must("held 12 @ 300k", planReplication({ amount: 300000, constituents: held }));
near("invested", plan300k.invested, 298289.54);
near("commission", plan300k.fees.commission, 745.72);
near("CDC — 12 trades at the floor", plan300k.fees.cdcTxn, 60);
near("buffer", plan300k.buffer, 904.74);
eq("no setup fee on an existing account", plan300k.fees.setup, 0);
near("Σ raw weight of the subset", plan300k.totalRawWeight, 77.39);

// Whole shares, floored, weights normalized.
for (const p of [all25, plan300k]) {
  near("normalized weights sum to 1", p.rows.reduce((s, r) => s + r.normWeight, 0), 1, 1e-9);
  ok(
    "every row is a floored whole-share count",
    p.rows.every((r) => Number.isInteger(r.shares) && r.shares === Math.floor(r.target / r.price)),
  );
  ok("no row overspends its target", p.rows.every((r) => r.cost <= r.target + 1e-9));
  ok("buffer is never negative", p.buffer >= 0);
  ok(
    "fees are only charged on rows that trade",
    p.fees.commission > 0 && p.tradeCount === p.rows.filter((r) => r.shares > 0).length,
  );
  ok("the buy list holds exactly the trading rows", p.buyList.length === p.tradeCount);
  near("grand total is invested + fees", p.grandTotal, p.invested + p.fees.total, 0.011);
}

// ------------------------------------------------------- new account + repair (§5, §6)

section("New account and the over-budget repair");

const newAcct = must("held 12 @ 300k, new account", planReplication({ amount: 300000, constituents: held, isNewAccount: true }));
near("setup is charged in full", newAcct.fees.setup, 923.15);
ok("buffer still fits", newAcct.buffer >= 0);
ok(
  "the repair loop reports what it trimmed",
  newAcct.warnings.some((w) => w.startsWith("Trimmed one share of")),
);
ok(
  "…and the plan really is smaller than the existing-account one",
  newAcct.invested < plan300k.invested,
);
// The existing-account plan leaves 904.74 spare, so the 923.15 setup overshoots by
// 18.41 — a single share is all the repair should give up to close that.
const sharesOf = (p: ReplicationPlan) => p.rows.reduce((s, r) => s + r.shares, 0);
eq("the repair gives up exactly one share", sharesOf(plan300k) - sharesOf(newAcct), 1);

// ------------------------------------------------------------- small amounts (§6)

section("Small amounts");

const small = must("held 12 @ 10k", planReplication({ amount: 10000, constituents: held }));
near("invested", small.invested, 8637.79);
near("trading fees", small.fees.total, 81.59);
near("buffer", small.buffer, 1280.62);
ok(
  "flags low fidelity when per-trade minimums dominate",
  small.warnings.some((w) => w.includes("Low replication fidelity")),
);
ok(
  "…and says which names can't round cleanly",
  small.warnings.some((w) => w.startsWith("Coarse fit:")),
);
ok("one warning per issue, not one per row", small.warnings.length <= 3);

const tiny = must("held 12 @ 500", planReplication({ amount: 500, constituents: held }));
eq("nothing is bought", tiny.invested, 0);
eq("so nothing is charged", tiny.fees.total, 0);
near("and the whole amount is left over", tiny.buffer, 500);
eq("the buy list is empty rather than fictional", tiny.buyList.length, 0);
ok(
  "…and says so plainly",
  tiny.warnings.some((w) => w.startsWith("Nothing is buyable")),
);

// A zero-share row is surfaced, not dropped from the weighting.
const lopsided = must(
  "one very expensive name in a cheap basket",
  planReplication({
    amount: 20000,
    constituents: [
      { symbol: "CHEAP", price: 50, weight: 90 },
      { symbol: "DEAR", price: 12000, weight: 10 },
    ],
  }),
);
eq("the unaffordable name gets 0 shares", lopsided.rows.find((r) => r.symbol === "DEAR")?.shares, 0);
near("…but still holds its 10% of the weighting", lopsided.rows.find((r) => r.symbol === "DEAR")!.normWeight, 0.1, 1e-9);
ok(
  "…and is named in a warning",
  lopsided.warnings.some((w) => w.includes("DEAR") && w.includes("rounded to 0 shares")),
);

// ------------------------------------------------------------------ validation (§6)

section("Validation");

const bad = (label: string, result: ReplicationResult, expect: string) => {
  ok(label, !result.ok && result.error.includes(expect), !result.ok ? result.error : "got a plan");
};

bad("rejects a zero amount", planReplication({ amount: 0, constituents: held }), "greater than 0");
bad("rejects a negative amount", planReplication({ amount: -5, constituents: held }), "greater than 0");
bad("rejects an empty basket", planReplication({ amount: 1000, constituents: [] }), "at least one symbol");
bad(
  "rejects a missing price rather than guessing one",
  planReplication({ amount: 1000, constituents: [{ symbol: "X", price: 0, weight: 5 }] }),
  "no usable price",
);
bad(
  "rejects a basket with no weight between its names",
  planReplication({ amount: 1000, constituents: [{ symbol: "X", price: 10, weight: 0 }] }),
  "no index weight",
);
bad(
  "refuses when setup fees would eat the whole amount",
  planReplication({ amount: 900, constituents: held, isNewAccount: true }),
  "use up the whole amount",
);

// ------------------------------------------------------------------ order tickets

section("Order tickets");

const exDiv = must(
  "ex-dividend ticker",
  planReplication({
    amount: 100000,
    constituents: [
      { symbol: "FFCXD", price: 552.96, weight: 12.12 },
      { symbol: "MEBL", price: 587.28, weight: 7.32 },
    ],
  }),
);
// 12.12 / (12.12 + 7.32) of 100,000 is a 62,345.68 target; at 552.96 that floors to 112.
eq(
  "the buy list quotes the ticker you actually order",
  exDiv.buyList.find((b) => b.symbol === "FFCXD")?.shares,
  112,
);

const stale = must(
  "a reused price",
  planReplication({
    amount: 100000,
    constituents: [
      { symbol: "A", price: 100, weight: 50, stalePrice: true },
      { symbol: "B", price: 200, weight: 50 },
    ],
  }),
);
ok(
  "a reused price is flagged, never silently trusted",
  stale.warnings.some((w) => w.includes("marked *") && w.includes("A")),
);

// ----------------------------------------------------------------------- summary

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
