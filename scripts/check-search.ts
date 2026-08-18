/**
 * Standalone checks for the asset-search ranker.
 *
 * Run: npm run check:search
 *
 * No network, no database. The universe under test is the real seed catalogue plus
 * a couple of ledger-shaped PSX equities, so what is asserted is how the actual
 * app answers an actual query — "bullion" has to find gold because
 * `news/terms.ts` says it does, not because a fixture says so.
 *
 * The two properties worth the file: the scoring tiers stay ordered and further
 * apart than any bonus can bridge, and the ranking is a total order that does not
 * depend on the order the candidates arrived in.
 */
import { CATALOGUE } from "@/lib/markets/catalogue";
import type { AssetRef } from "@/lib/markets/types";
import {
  DEFAULT_LIMIT,
  HELD_BONUS,
  MATCH_FIELDS,
  MATCH_LABEL,
  MIN_SCORE,
  MULTI_WORD_FACTOR,
  SCORE,
  TIER_GAP,
  normalize,
  rankAssets,
  toCandidate,
  type SearchCandidate,
} from "@/lib/search/rank";

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

function close(label: string, actual: number, expected: number, tolerance = 1e-9) {
  ok(label, Math.abs(actual - expected) <= tolerance, `got ${actual}, want ${expected}`);
}

function section(name: string) {
  console.log(`\n${name}`);
}

/* --------------------------------------------------------------- the universe */

/**
 * PSX equities as `syncLedgerAssets` creates them: name equal to the symbol,
 * rank 100, not a benchmark. They are the assets most likely to be searched for
 * and the least well described, so they belong in the fixture.
 */
const LEDGER_ASSETS: AssetRef[] = ["LUCK", "PSO", "ATRL"].map((symbol) => ({
  id: `psx:${symbol}`,
  market: "psx" as const,
  symbol,
  name: symbol,
  kind: "stock" as const,
  currency: "PKR",
  source: "psx",
  sourceSymbol: symbol,
  rank: 100,
  benchmark: false,
}));

const UNIVERSE: SearchCandidate[] = [...CATALOGUE, ...LEDGER_ASSETS].map(toCandidate);

/** Rank against the whole universe, unlimited unless asked otherwise. */
function search(query: string, options: Parameters<typeof rankAssets>[2] = { limit: 0 }) {
  return rankAssets(query, UNIVERSE, options);
}

function ids(query: string, limit = 0): string[] {
  return search(query, { limit }).map((h) => h.candidate.id);
}

function top(query: string) {
  return search(query, { limit: 1 })[0];
}

/** A synthetic candidate, for the invariants that need a contrived match. */
function candidate(over: Partial<SearchCandidate> = {}): SearchCandidate {
  return {
    id: "stocks:ZZZ",
    market: "stocks",
    marketLabel: "US Stocks",
    symbol: "ZZZ",
    name: "Zed Industries",
    kind: "stock",
    currency: "USD",
    rank: 50,
    aliases: [],
    ...over,
  };
}

/* ---------------------------------------------------------------- normalize */

function checkNormalize() {
  section("normalize");

  eq("trims", normalize("  AAPL  "), "aapl");
  eq("lowercases", normalize("AaPl"), "aapl");
  eq("collapses runs of whitespace", normalize("US   Dollar"), "us dollar");
  eq("collapses tabs and newlines too", normalize("us\t\ndollar"), "us dollar");
  eq("leaves punctuation alone", normalize("S&P 500"), "s&p 500");
  eq("empty stays empty", normalize("   "), "");

  eq("an empty query matches nothing", search("").length, 0);
  eq("a whitespace query matches nothing", search("   ").length, 0);
  eq("a query matching nothing returns nothing", search("qwertyuiop").length, 0);
}

/* ------------------------------------------------------------------- tiers */

function checkTiers() {
  section("scoring tiers");

  // The order here is the claim the whole ranker rests on: an exact ticker beats
  // an exact name beats a synonym beats any partial.
  const ordered: [string, number][] = [
    ["idExact", SCORE.idExact],
    ["symbolExact", SCORE.symbolExact],
    ["nameExact", SCORE.nameExact],
    ["aliasExact", SCORE.aliasExact],
    ["symbolPrefix", SCORE.symbolPrefix],
    ["namePrefix", SCORE.namePrefix],
    ["aliasPrefix", SCORE.aliasPrefix],
    ["nameWord", SCORE.nameWord],
    ["aliasWord", SCORE.aliasWord],
    ["symbolInfix", SCORE.symbolInfix],
    ["nameInfix", SCORE.nameInfix],
    ["marketLabel", SCORE.marketLabel],
  ];

  for (let i = 1; i < ordered.length; i++) {
    const [name, score] = ordered[i];
    const [prevName, prev] = ordered[i - 1];
    ok(`${prevName} outranks ${name}`, prev > score, `${prev} vs ${score}`);
    ok(
      `the gap ${prevName}→${name} is at least TIER_GAP`,
      prev - score >= TIER_GAP - 1e-9,
      `gap ${(prev - score).toFixed(3)} < ${TIER_GAP}`,
    );
  }

  ok("no tier exceeds 1", ordered.every(([, s]) => s <= 1));
  ok("the held bonus cannot bridge a tier", HELD_BONUS < TIER_GAP);
  ok("MIN_SCORE is below the weakest tier", MIN_SCORE < SCORE.marketLabel);
  ok(
    "MIN_SCORE keeps the weakest reachable multi-word match",
    MIN_SCORE <= SCORE.marketLabel * MULTI_WORD_FACTOR,
    `${MIN_SCORE} > ${(SCORE.marketLabel * MULTI_WORD_FACTOR).toFixed(3)}`,
  );
  ok("a multi-word match is weaker than the same phrase whole", MULTI_WORD_FACTOR < 1);

  for (const field of MATCH_FIELDS) {
    ok(`${field} has a label`, typeof MATCH_LABEL[field] === "string" && MATCH_LABEL[field].length > 0);
  }
  eq("every label is a field", Object.keys(MATCH_LABEL).length, MATCH_FIELDS.length);
}

/* ------------------------------------------------------------------ exact */

function checkExact() {
  section("exact matches");

  const aapl = top("aapl");
  eq("a ticker finds its asset", aapl?.candidate.id, "stocks:AAPL");
  eq("…by the symbol field", aapl?.field, "symbol");
  close("…at the exact-symbol score", aapl?.score ?? 0, SCORE.symbolExact);
  eq("…reporting the ticker it matched", aapl?.matched, "AAPL");

  eq("case does not matter", top("AAPL")?.candidate.id, "stocks:AAPL");
  eq("surrounding space does not matter", top("  aapl  ")?.candidate.id, "stocks:AAPL");

  const byId = top("psx:luck");
  eq("a full asset id finds its asset", byId?.candidate.id, "psx:LUCK");
  eq("…by the id field", byId?.field, "id");
  close("…scoring 1", byId?.score ?? 0, SCORE.idExact);

  const apple = top("apple");
  eq("a name finds its asset", apple?.candidate.id, "stocks:AAPL");
  eq("…by the name field", apple?.field, "name");
  close("…at the exact-name score", apple?.score ?? 0, SCORE.nameExact);

  // A ticker that is also a hyphenated string, and a query with a regex
  // metacharacter in it. Both would break a ranker that built patterns naively.
  eq("a hyphenated ticker matches exactly", top("brk-b")?.candidate.id, "stocks:BRK-B");
  const sp = top("s&p");
  eq("an ampersand alias matches", sp?.candidate.id, "indices:SPX");
  eq("…by the alias field", sp?.field, "alias");
  eq("…reporting the alias, not the name", sp?.matched, "S&P");
  eq("a multi-word alias matches as a phrase", top("s&p 500")?.candidate.id, "indices:SPX");
}

/* ----------------------------------------------------------------- aliases */

function checkAliases() {
  section("aliases from news/terms.ts");

  const bullion = top("bullion");
  eq("a publisher's house word finds the metal", bullion?.candidate.id, "commodities:XAU");
  eq("…by the alias field", bullion?.field, "alias");
  eq("…and says which synonym it was", bullion?.matched, "bullion");
  close("…at the exact-alias score", bullion?.score ?? 0, SCORE.aliasExact);

  eq("the Dow", top("the dow")?.candidate.id, "indices:DJI");
  eq("greenback", top("greenback")?.candidate.id, "forex:DXY");
  eq("rupee", top("rupee")?.candidate.id, "forex:USDPKR");
  eq("yen", top("yen")?.candidate.id, "forex:USDJPY");
  eq("nikkei", top("nikkei")?.candidate.id, "indices:N225");
  eq("fear gauge", top("fear gauge")?.candidate.id, "indices:VIX");
  eq("berkshire", top("berkshire")?.candidate.id, "stocks:BRK-B");
  eq("google finds Alphabet", top("google")?.candidate.id, "stocks:GOOGL");
  eq("facebook finds Meta", top("facebook")?.candidate.id, "stocks:META");
  eq("ripple finds XRP", top("ripple")?.candidate.id, "crypto:XRP");

  const gold = toCandidate(CATALOGUE.find((a) => a.id === "commodities:XAU")!);
  ok("a candidate carries its synonyms", gold.aliases.includes("bullion"));
  ok("…but not its own name again", !gold.aliases.some((a) => a.toLowerCase() === "gold"));
  eq("…and the market's display label", gold.marketLabel, "Commodities");
  eq("…its currency", gold.currency, "USD");
  eq("…and its kind", gold.kind, "commodity");
}

/* ----------------------------------------------------------------- partial */

function checkPartial() {
  section("partial matches");

  const aap = top("aap");
  eq("a ticker prefix finds the asset", aap?.candidate.id, "stocks:AAPL");
  close("…at the prefix score", aap?.score ?? 0, SCORE.symbolPrefix);

  const micro = search("micro", { limit: 0 });
  eq("a name prefix outranks a word inside a name", micro[0]?.candidate.id, "stocks:MSFT");
  close("…the prefix scoring as one", micro[0]?.score ?? 0, SCORE.namePrefix);
  const amd = micro.find((h) => h.candidate.id === "stocks:AMD");
  ok("…and the interior word still matches", amd != null);
  close("…at the word score", amd?.score ?? 0, SCORE.nameWord);

  const devices = top("devices");
  eq("a word inside a name matches", devices?.candidate.id, "stocks:AMD");
  close("…at the word score", devices?.score ?? 0, SCORE.nameWord);

  const treasuries = ids("treasury");
  ok("a common word finds every asset naming it", treasuries.length > 3);
  ok("…including the 10-year yield", treasuries.includes("bonds:US10Y"));
  ok("…and the long bond ETF", treasuries.includes("bonds:TLT"));

  // One character is a real ticker (V is Visa), so an exact match still counts —
  // but nothing may match *inside* a field on one character.
  const single = search("v", { limit: 0 });
  eq("a single character finds its ticker", single[0]?.candidate.id, "stocks:V");
  ok(
    "…and matches nothing weaker than a prefix",
    single.every((h) => h.score >= SCORE.aliasPrefix - 1e-9),
    `weakest was ${Math.min(...single.map((h) => h.score))}`,
  );
  ok("…so the whole catalogue does not come back", single.length < 12, `${single.length} hits`);

  const market = top("commodities");
  eq("a market name finds its assets", market?.candidate.market, "commodities");
  eq("…by the market field", market?.field, "market");
  close("…at the weakest score", market?.score ?? 0, SCORE.marketLabel);
  // "crypto" is both a market label and the leading word of nothing in the
  // catalogue, so the market tier is what answers — but Bitcoin, matched by name
  // on a different query, must always outrank a market-label hit.
  ok(
    "a name match beats any market-label match",
    (top("bitcoin")?.score ?? 0) > (top("crypto")?.score ?? 0),
  );
}

/* -------------------------------------------------------------- multi-word */

function checkMultiWord() {
  section("multi-word queries");

  const phrase = top("us dollar index");
  eq("a full name is one name match, not three word matches", phrase?.candidate.id, "forex:DXY");
  eq("…by the name field", phrase?.field, "name");
  close("…scoring as an exact name", phrase?.score ?? 0, SCORE.nameExact);

  const appleStock = ids("apple stock");
  ok("every word must land somewhere", appleStock.includes("stocks:AAPL"));
  const aaplHit = search("apple stock", { limit: 0 }).find((h) => h.candidate.id === "stocks:AAPL");
  // "apple" is an exact name; "stock" only reaches the market label. The reported
  // field is the stronger of the two, which is the one worth telling a reader.
  eq("…and the strongest word decides the reported field", aaplHit?.field, "name");
  close(
    "…with the score averaged and discounted",
    aaplHit?.score ?? 0,
    ((SCORE.nameExact + SCORE.marketLabel) / 2) * MULTI_WORD_FACTOR,
  );

  eq("a word that lands nowhere kills the hit", search("apple qwertyuiop").length, 0);
  eq("…in either order", search("qwertyuiop apple").length, 0);

  ok("a two-word alias phrase matches", ids("dollar index").includes("forex:DXY"));
  ok("a two-word name matches", ids("home depot").includes("stocks:HD"));
  ok("word order does not matter", ids("depot home").includes("stocks:HD"));

  // A one-character word cannot carry a multi-word query — it would match inside
  // half the catalogue and rank the result on the noise.
  eq("a one-character word falls back to the whole phrase", search("a apple").length, 0);
  ok("…while the phrase itself still works", ids("apple").includes("stocks:AAPL"));
}

/* -------------------------------------------------------------- held boost */

function checkHeld() {
  section("held positions");

  const heldIds = new Set(["psx:LUCK"]);
  const plain = top("luck");
  const boosted = search("luck", { limit: 1, heldIds })[0];

  eq("the ticker matches either way", plain?.candidate.id, "psx:LUCK");
  eq("a held asset is flagged", boosted?.held, true);
  eq("…and an unheld one is not", plain?.held, false);
  close("…the boost being exactly HELD_BONUS", (boosted?.score ?? 0) - (plain?.score ?? 0), HELD_BONUS);

  const exactId = search("psx:luck", { limit: 1, heldIds })[0];
  close("a held exact id is still capped at 1", exactId?.score ?? 0, 1);

  // The property the bonus exists to have: it decides a tie, never a tier.
  const pair = [
    candidate({ id: "a:1", symbol: "AAX", name: "Alpha", rank: 1 }),
    candidate({ id: "b:2", symbol: "ZAAXZ", name: "Beta", rank: 1 }),
  ];
  const crossing = rankAssets("aax", pair, { limit: 0, heldIds: new Set(["b:2"]) });
  eq("an exact ticker beats a held substring", crossing[0]?.candidate.id, "a:1");
  eq("…and the held one is still returned", crossing[1]?.candidate.id, "b:2");
  ok("…below it", (crossing[0]?.score ?? 0) > (crossing[1]?.score ?? 0));

  const tie = [
    candidate({ id: "a:1", symbol: "AAA", name: "Alpha", rank: 5 }),
    candidate({ id: "b:2", symbol: "AAA", name: "Alpha", rank: 5 }),
  ];
  eq(
    "between identical matches, the held one wins",
    rankAssets("aaa", tie, { limit: 0, heldIds: new Set(["b:2"]) })[0]?.candidate.id,
    "b:2",
  );
}

/* ------------------------------------------------------------ ordering */

function checkOrdering() {
  section("ordering and determinism");

  const once = ids("a", 0);
  const twice = ids("a", 0);
  eq("the same query gives the same answer", once.join(","), twice.join(","));

  // The claim that matters: order in, no influence on order out. A ranking that
  // depended on catalogue order would drift the moment a row was added.
  const shuffled = [...UNIVERSE].reverse();
  eq(
    "reversing the candidates changes nothing",
    rankAssets("a", shuffled, { limit: 0 }).map((h) => h.candidate.id).join(","),
    once.join(","),
  );
  eq(
    "…nor does an interleaved order",
    rankAssets(
      "a",
      [...UNIVERSE.filter((_, i) => i % 2 === 1), ...UNIVERSE.filter((_, i) => i % 2 === 0)],
      { limit: 0 },
    )
      .map((h) => h.candidate.id)
      .join(","),
    once.join(","),
  );

  const scores = search("a", { limit: 0 }).map((h) => h.score);
  ok(
    "scores come back descending",
    scores.every((s, i) => i === 0 || s <= scores[i - 1] + 1e-9),
  );
  ok("nothing below MIN_SCORE is returned", scores.every((s) => s >= MIN_SCORE));

  // Equal scores fall back to catalogue rank, so a mega-cap comes before an
  // obscure holding rather than whichever the database happened to return first.
  const ranked = [
    candidate({ id: "a:1", symbol: "AAX", name: "One", rank: 90 }),
    candidate({ id: "b:2", symbol: "AAX", name: "One", rank: 2 }),
  ];
  eq(
    "a tie is broken by catalogue rank",
    rankAssets("aax", ranked, { limit: 0 })[0]?.candidate.id,
    "b:2",
  );

  const sameRank = [
    candidate({ id: "stocks:ZB", market: "stocks", symbol: "ZBX", name: "Two", rank: 7 }),
    candidate({ id: "crypto:ZA", market: "crypto", symbol: "ZAX", name: "One", rank: 7 }),
  ];
  eq(
    "then by market display order",
    rankAssets("z", sameRank, { limit: 0 })[0]?.candidate.id,
    "stocks:ZB",
  );

  const sameMarket = [
    candidate({ id: "stocks:B", symbol: "ZZB", name: "B", rank: 7 }),
    candidate({ id: "stocks:A", symbol: "ZZA", name: "A", rank: 7 }),
  ];
  eq(
    "then by symbol",
    rankAssets("zz", sameMarket, { limit: 0 })[0]?.candidate.id,
    "stocks:A",
  );
}

/* -------------------------------------------------------------------- limit */

function checkLimit() {
  section("limits");

  const all = search("a", { limit: 0 });
  ok("an unlimited search returns everything above the floor", all.length > DEFAULT_LIMIT);
  eq("a limit truncates", search("a", { limit: 3 }).length, 3);
  eq("…keeping the best three", search("a", { limit: 3 }).map((h) => h.candidate.id).join(","), all.slice(0, 3).map((h) => h.candidate.id).join(","));
  eq("the default limit applies when none is given", rankAssets("a", UNIVERSE).length, DEFAULT_LIMIT);
  eq("a limit larger than the result set is harmless", search("bullion", { limit: 99 }).length, 1);
  eq("a limit on an empty result set is harmless", search("qwertyuiop", { limit: 5 }).length, 0);
}

/* --------------------------------------------------------------------- run */

function main() {
  checkNormalize();
  checkTiers();
  checkExact();
  checkAliases();
  checkPartial();
  checkMultiWord();
  checkHeld();
  checkOrdering();
  checkLimit();

  if (failures > 0) {
    console.error(`\nFAILED — ${failures} of ${checks} checks failed.`);
    process.exit(1);
  }
  console.log(`\nPASS — ${checks}/${checks} checks passed.`);
}

main();
