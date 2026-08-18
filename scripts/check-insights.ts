/**
 * Standalone checks for the AI layer and the insight engine: the ask-validate-
 * repair loop, week arithmetic, evidence assembly, the brief the model reads, and
 * — at length — the validator that decides whether an answer is honest enough to
 * store.
 *
 * Run: npm run check:insights
 *
 * No network, no database and no model. Every model call in here is a scripted
 * stub returning canned JSON, which is what makes it possible to assert on the
 * repair turn: the thing that actually determines whether a small local model
 * converges on a usable answer.
 *
 * The deliberate omission: nothing here checks the model's prose. That is not
 * testable and pretending otherwise would be theatre. What is testable is the
 * boundary around it — that a citation resolves, that a figure was given to it,
 * that a confident claim rests on provenance — and that is what is checked.
 */
import {
  parseJsonAnswer,
  runStructuredTask,
  NotJsonError,
  StructuredTaskError,
  type AiProvider,
  type StructuredRequest,
} from "@/lib/ai";
import {
  PACK_LIMITS,
  VIA_EVIDENCE,
  buildEvidencePack,
  buildMovements,
  hasSomethingToExplain,
  renderPack,
  selectArticles,
} from "@/lib/insights/evidence";
import { buildRepair, buildRequest, SYSTEM_PROMPT } from "@/lib/insights/prompt";
import { INSIGHT_SCHEMA, LIMITS, supportedFigures, validateInsight } from "@/lib/insights/schema";
import { resolveReadings, statusFor } from "@/lib/insights/generate";
import {
  endOfDay,
  weekEndOf,
  weekStartOf,
  type EvidencePack,
  type InsightDraft,
} from "@/lib/insights/types";
import type { AssetPerformance } from "@/lib/markets/performance";
import type { AssetRef } from "@/lib/markets/types";
import type { NewsCandidate } from "@/lib/news/relevance";
import type { NewsItem } from "@/lib/news/store";

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

function section(name: string) {
  console.log(`\n${name}`);
}

/** A rejection whose message mentions `needle` — the model has to be told what to fix. */
function rejects(label: string, errors: string[], needle: string) {
  ok(
    label,
    errors.some((e) => e.toLowerCase().includes(needle.toLowerCase())),
    `no error mentioned "${needle}" in: ${errors.join(" | ") || "(none)"}`,
  );
}

/* --------------------------------------------------------------- fixtures */

function testAsset(over: Partial<AssetRef> = {}): AssetRef {
  return {
    id: "commodities:XAU",
    market: "commodities",
    symbol: "XAU",
    name: "Gold",
    kind: "commodity",
    currency: "USD",
    source: "yahoo",
    sourceSymbol: "GC=F",
    rank: 1,
    benchmark: true,
    ...over,
  };
}

const GOLD = testAsset();
const SILVER = testAsset({ id: "commodities:XAG", symbol: "XAG", name: "Silver", sourceSymbol: "SI=F" });

function candidate(asset: AssetRef, changePct: number, sigma: number, zScore: number): NewsCandidate {
  return { asset, changePct, sigma, zScore };
}

function perf(assetId: string, latest: number, latestDate: string, weekPct: number | null): AssetPerformance {
  return {
    assetId,
    latest,
    latestDate,
    periods:
      weekPct == null
        ? {}
        : {
            week: {
              from: latest / (1 + weekPct / 100),
              to: latest,
              change: 0,
              changePct: weekPct,
              fromDate: "2026-08-10",
              toDate: latestDate,
            },
          },
  };
}

function article(over: Partial<NewsItem["article"]> = {}, matches: NewsItem["matches"] = []): NewsItem {
  return {
    article: {
      id: "a",
      title: "A headline",
      url: "https://example.com/a",
      source: "Reuters",
      provider: "yahoo",
      summary: null,
      publishedAt: new Date("2026-08-18T09:00:00Z"),
      market: "commodities",
      ...over,
    },
    matches,
  };
}

const WEEK = "2026-08-17";

/** The brief every validation check below is measured against. */
function samplePack(): EvidencePack {
  return buildEvidencePack({
    market: "commodities",
    weekStart: WEEK,
    candidates: [
      candidate(GOLD, -3.41, 1.07, -3.2),
      candidate(SILVER, 5.24, 2.1, 2.5),
    ],
    performance: new Map([
      ["commodities:XAU", perf("commodities:XAU", 3912.4, "2026-08-18", -4.1)],
      ["commodities:XAG", perf("commodities:XAG", 48.2, "2026-08-18", 6.05)],
    ]),
    news: [
      article(
        {
          id: "gold-1",
          title: "Gold slides as dollar firms after hot inflation print",
          url: "https://example.com/gold-1",
          summary: "Bullion gave up early gains.",
          publishedAt: new Date("2026-08-18T08:00:00Z"),
        },
        [{ assetId: "commodities:XAU", score: 1, via: "feed", symbol: "XAU", name: "Gold", market: "commodities" }],
      ),
      article(
        {
          id: "silver-1",
          title: "Industrial demand lifts silver to a two-year high",
          url: "https://example.com/silver-1",
          publishedAt: new Date("2026-08-17T12:00:00Z"),
        },
        [{ assetId: "commodities:XAG", score: 0.65, via: "name", symbol: "XAG", name: "Silver", market: "commodities" }],
      ),
      article(
        {
          id: "macro-1",
          title: "Fed holds rates, signals patience",
          url: "https://example.com/macro-1",
          publishedAt: new Date("2026-08-17T18:00:00Z"),
        },
        [],
      ),
    ],
    marketChangePct: 1.2,
    marketBasis: "Gold (XAU)",
    advancers: 6,
    decliners: 5,
    assetsTracked: 11,
  });
}

/** An answer that should pass every rule. */
function goodDraft(): InsightDraft {
  return {
    headline: "Metals split as the dollar firms",
    summary:
      "The retrieved coverage is dominated by the inflation print and the Fed's decision to hold. A1 reports gold giving up gains as the dollar firmed; A2 attributes silver's move to industrial demand.",
    movements: [
      {
        ref: "M1",
        verdict: "explained",
        inference:
          "A1, filed against gold by its publisher, reports bullion sliding as the dollar firmed after the inflation print. That is consistent with a 3.4% session.",
        citations: ["A1"],
        confidence: "high",
      },
      {
        ref: "M2",
        verdict: "partial",
        inference:
          "A2 names silver and points to industrial demand, but it is a text match rather than a filed story and does not account for the size of the move.",
        citations: ["A2"],
        confidence: "medium",
      },
    ],
    watchItems: ["The next inflation print", "Dollar strength"],
  };
}

/** A stub model returning canned answers in order — no network. */
function scriptedProvider(answers: string[]): { provider: AiProvider; asks: StructuredRequest[] } {
  const asks: StructuredRequest[] = [];
  return {
    asks,
    provider: {
      label: "scripted",
      async complete(request) {
        asks.push(request);
        return answers[Math.min(asks.length - 1, answers.length - 1)];
      },
    },
  };
}

/* ------------------------------------------------------------------ weeks */

function checkWeeks() {
  section("Weeks");

  eq("a Monday is its own week start", weekStartOf("2026-08-17"), "2026-08-17");
  eq("…as is the Tuesday after it", weekStartOf("2026-08-18"), "2026-08-17");
  eq("…and the Sunday that closes it", weekStartOf("2026-08-23"), "2026-08-17");
  eq("the Monday after starts a new week", weekStartOf("2026-08-24"), "2026-08-24");
  eq("a week runs Monday to Sunday", weekEndOf("2026-08-17"), "2026-08-23");

  // A week key has to be stable across a day, or the cache never hits and every
  // page view pays for a generation.
  eq(
    "the key does not move with the time of day",
    weekStartOf(new Date("2026-08-18T23:59:00Z")),
    weekStartOf(new Date("2026-08-18T00:01:00Z")),
  );
  eq("…and works across a year boundary", weekStartOf("2027-01-01"), "2026-12-28");
  eq("…and across a leap day", weekStartOf("2028-02-29"), "2028-02-28");

  // Where a week's evidence window closes. A date alone would cut the last day
  // off, dropping every headline filed after midnight on the Sunday.
  eq("a day ends at its last millisecond", endOfDay("2026-08-23").toISOString(), "2026-08-23T23:59:59.999Z");
  ok("…which is after anything published that day", endOfDay("2026-08-23") > new Date("2026-08-23T22:00:00Z"));
  ok("…and before the next", endOfDay("2026-08-23") < new Date("2026-08-24T00:00:00Z"));
}

/* ----------------------------------------------------------------- schema */

function checkSchema() {
  section("The response schema");

  // Same subset structured outputs accepts as SPEC_SCHEMA — additionalProperties
  // false, exhaustive `required`, no numeric or length constraints. Getting this
  // wrong is a 400 at generation time, which is the worst moment to find out.
  const unsupported = ["minimum", "maximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "pattern"];
  const problems: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const keyword of unsupported) {
      if (keyword in obj) problems.push(`${path} uses unsupported "${keyword}"`);
    }
    if (obj.type === "object") {
      if (obj.additionalProperties !== false) problems.push(`${path} allows additional properties`);
      const properties = Object.keys((obj.properties ?? {}) as object);
      const required = (obj.required ?? []) as string[];
      const missing = properties.filter((p) => !required.includes(p));
      if (missing.length > 0) problems.push(`${path} leaves ${missing.join(", ")} optional`);
    }
    for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
  };
  walk(INSIGHT_SCHEMA, "schema");
  ok("stays within structured outputs' subset", problems.length === 0, problems.join("; "));

  // The enums are the contract between the schema and the validator; a value in
  // one and not the other is a rejection loop the model can never escape.
  const movement = INSIGHT_SCHEMA.properties.movements.items.properties;
  eq("verdicts match the validator's", movement.verdict.enum.join(","), "explained,partial,insufficient");
  eq("confidences match the validator's", movement.confidence.enum.join(","), "low,medium,high");
}

/* --------------------------------------------------------------- evidence */

function checkEvidence() {
  section("Assembling the evidence");

  const movements = buildMovements(
    [candidate(GOLD, -3.41, 1.07, -3.2), candidate(SILVER, 5.24, 2.1, 2.5)],
    new Map([["commodities:XAU", perf("commodities:XAU", 3912.4, "2026-08-18", -4.1)]]),
  );
  eq("movements are numbered from M1", movements[0].ref, "M1");
  eq("…in the order the mover list gave them", movements[1].symbol, "XAG");
  eq("…carrying the session move", movements[0].changePct, -3.41);
  eq("…and the weekly one from performance", movements[0].weekChangePct, -4.1);
  eq("…and the latest close", movements[0].price, 3912.4);
  eq("an asset with no performance still becomes a fact", movements[1].weekChangePct, null);

  const many = buildMovements(
    Array.from({ length: 20 }, () => candidate(GOLD, -3, 1, -3)),
    new Map(),
  );
  eq("the movement list is bounded", many.length, PACK_LIMITS.movements);

  const pack = samplePack();
  eq("articles are numbered from A1", pack.articles[0].ref, "A1");
  eq("…strongest link first", pack.articles[0].articleId, "gold-1");
  eq("…then the weaker text match", pack.articles[1].articleId, "silver-1");
  // A market-wide story explains a move without naming the instrument. Dropping
  // it for matching nothing would lose the best evidence there is some weeks.
  eq("…and an unlinked market story is kept, last", pack.articles[2].articleId, "macro-1");
  eq("…with no links of its own", pack.articles[2].links.length, 0);
  eq("a link carries how it was made", pack.articles[0].links[0].via, "feed");
  eq("…and which movement it bears on", pack.articles[0].links[0].ref, "M1");
  eq("the pack is dated to its latest session", pack.asOf, "2026-08-18");

  // A Monday move often answers to Friday's story, so the window reaches back
  // past the week itself — but not indefinitely.
  const stale = selectArticles(
    [article({ id: "old", publishedAt: new Date("2026-08-01T00:00:00Z") })],
    [],
    { weekStart: WEEK },
  );
  eq("a headline from before the window is dropped", stale.length, 0);
  const friday = selectArticles(
    [article({ id: "fri", publishedAt: new Date("2026-08-15T00:00:00Z") })],
    [],
    { weekStart: WEEK },
  );
  eq("…but the Friday before the week is kept", friday.length, 1);

  // The window is bounded at both ends, because a pack for a past week must not
  // sweep in the present: generating --week=<past> filed the current week's
  // headlines, and the current week's moves, under the old week's key.
  const PAST = "2026-07-06"; // closes Sunday 2026-07-12
  const late = selectArticles(
    [article({ id: "late", publishedAt: new Date("2026-08-18T09:00:00Z") })],
    [],
    { weekStart: PAST },
  );
  eq("a headline published after the week is dropped", late.length, 0);
  const sunday = selectArticles(
    [article({ id: "sun", publishedAt: new Date("2026-07-12T23:00:00Z") })],
    [],
    { weekStart: PAST },
  );
  eq("…one from the week's closing day is kept", sunday.length, 1);
  const monday = selectArticles(
    [article({ id: "mon", publishedAt: new Date("2026-07-06T08:00:00Z") })],
    [],
    { weekStart: PAST },
  );
  eq("…as is one from the day it opened", monday.length, 1);
  // The current week has not closed yet, so nothing about today's pack changes.
  const current = selectArticles([article({ id: "now" })], [], { weekStart: WEEK });
  eq("this week's pack still keeps this week's headline", current.length, 1);

  // An insight needs a movement to anchor it. Headlines alone are not enough, and
  // that is not a token-saving rule: asked about twenty headlines and no movements,
  // an 8B model invented M1…M20, one per article, because "one entry per M-ref"
  // reads as nonsense when there are no M-refs.
  ok("a pack with a movement is worth explaining", hasSomethingToExplain(pack));
  ok("…a market with headlines but nothing unusual is not", !hasSomethingToExplain({ ...pack, movements: [] }));
  const quiet = buildEvidencePack({
    market: "commodities",
    weekStart: WEEK,
    candidates: [],
    performance: new Map(),
    news: [],
    marketChangePct: null,
    marketBasis: "the median across the market",
    advancers: 0,
    decliners: 0,
    assetsTracked: 11,
  });
  ok("…nor is a market with neither", !hasSomethingToExplain(quiet));
}

/* ----------------------------------------------------------------- render */

function checkRender() {
  section("The brief the model reads");

  const text = renderPack(samplePack());
  ok("names the market", text.includes("Commodities"));
  ok("dates the week", text.includes("2026-08-17 to 2026-08-23"));
  ok("gives the session move", text.includes("-3.41%"));
  ok("…in units of the asset's own volatility", text.includes("3.2σ"));
  ok("…and the weekly move", text.includes("-4.10%"));
  ok("…and the close in its own currency", text.includes("$3,912.40"));
  ok("numbers every headline", text.includes("A1") && text.includes("A3"));
  ok("attributes each to its publisher", text.includes("Reuters"));

  // The distinction between provenance and a text match is the difference between
  // evidence and coincidence. It must survive into the prompt intact.
  ok("says when a publisher filed the story", text.includes(VIA_EVIDENCE.feed));
  ok("…and when it is only a text match", text.includes(VIA_EVIDENCE.name));
  ok("…and marks a market-wide story as such", text.includes("a market-wide story"));

  // The app stores headlines and links, never article bodies. The model has to
  // know that, or it will write about what an article "explains".
  ok("says the model has only titles", text.toLowerCase().includes("not read any article body"));

  const quiet = renderPack({ ...samplePack(), movements: [], articles: [] });
  ok("a quiet week says so plainly", quiet.includes("no asset in this market moved unusually"));
  ok("…and an empty feed says so too", quiet.includes("none were retrieved"));

  const request = buildRequest(samplePack());
  ok("the request wraps the brief", request.includes("FACTS") && request.includes("HEADLINES"));
}

/* ------------------------------------------------------------- the prompt */

function checkPrompt() {
  section("What the model is told");

  // These are the brief's hard requirements. Each is also enforced by the
  // validator, but a model that understands the rule fails it less often — and a
  // rule that quietly falls out of the prompt is a regression nothing else catches.
  ok("separates fact from inference", /A fact is what the price data says/.test(SYSTEM_PROMPT));
  ok("forbids asserting a cause", SYSTEM_PROMPT.includes("Gold fell because"));
  ok("forbids inventing figures", /must be a figure from the FACTS block/.test(SYSTEM_PROMPT));
  ok("forbids inventing sources", /Never mention a story, a publisher, or an event that is not/.test(SYSTEM_PROMPT));
  ok("says insufficient is a good answer", SYSTEM_PROMPT.includes("INSUFFICIENT IS A GOOD ANSWER"));
  ok("grades the evidence", SYSTEM_PROMPT.includes("the publisher filed this story"));
  ok("gates high confidence on provenance", /Use "high" only when/.test(SYSTEM_PROMPT));
  ok("rules out advice", SYSTEM_PROMPT.includes("never make it a recommendation"));

  const repair = buildRepair(["M1 cites \"A9\", which is not in the HEADLINES block."]);
  ok("a repair turn carries the specific complaint", repair.includes("A9"));
  ok("…and reminds it that insufficient is allowed", repair.includes("insufficient"));

  // One bad answer can fail the same rule two dozen times over. Handing all of them
  // back grows the conversation without teaching anything more — this is what made a
  // rejected answer to an unanchored brief spiral in the wild.
  const many = buildRepair(Array.from({ length: 21 }, (_, i) => `problem ${i + 1}`));
  ok("a repair turn is bounded", (many.match(/^- /gm) ?? []).length <= 9);
  ok("…and says how many it left out", many.includes("and 13 more"));
  ok("…while still carrying the first ones verbatim", many.includes("problem 1"));
}

/* -------------------------------------------------------------- validator */

function checkValidator() {
  section("Validating an answer");

  const pack = samplePack();
  const good = validateInsight(goodDraft(), pack);
  ok("a well-supported answer passes", good.ok, good.ok ? "" : good.errors.join(" | "));

  const bad = (mutate: (d: InsightDraft) => InsightDraft): string[] => {
    const result = validateInsight(mutate(goodDraft()), pack);
    return result.ok ? [] : result.errors;
  };

  rejects(
    "a movement that was never in the brief is refused",
    bad((d) => ({ ...d, movements: [...d.movements, { ...d.movements[0], ref: "M9" }] })),
    "not in the FACTS block",
  );
  rejects(
    "a movement left out is refused",
    bad((d) => ({ ...d, movements: [d.movements[0]] })),
    "has no entry",
  );
  rejects(
    "the same movement twice is refused",
    bad((d) => ({ ...d, movements: [...d.movements, d.movements[0]] })),
    "more than once",
  );
  rejects(
    "a citation we never supplied is refused",
    bad((d) => ({ ...d, movements: [{ ...d.movements[0], citations: ["A9"] }, d.movements[1]] })),
    "not in the HEADLINES block",
  );

  // The verdict and its evidence have to agree, in both directions. This is what
  // keeps "insufficient" honest and stops "explained" being asserted for free.
  rejects(
    "an explanation with nothing behind it is refused",
    bad((d) => ({ ...d, movements: [{ ...d.movements[0], citations: [] }, d.movements[1]] })),
    "cites nothing",
  );
  rejects(
    "…and a hedged 'insufficient' with citations is refused",
    bad((d) => ({
      ...d,
      movements: [{ ...d.movements[0], verdict: "insufficient" }, d.movements[1]],
    })),
    "marked insufficient but cites",
  );

  // The rule the whole news layer's `via` field exists to make possible.
  rejects(
    "high confidence on a text match alone is refused",
    bad((d) => ({ ...d, movements: [d.movements[0], { ...d.movements[1], confidence: "high" }] })),
    "filed against XAG",
  );
  const onSymbol = samplePack();
  onSymbol.articles[1].links[0].via = "symbol";
  const symbolOk = validateInsight(
    { ...goodDraft(), movements: [goodDraft().movements[0], { ...goodDraft().movements[1], confidence: "high" }] },
    onSymbol,
  );
  ok("…but a ticker in the text supports it", symbolOk.ok, symbolOk.ok ? "" : symbolOk.errors.join(" | "));
  rejects(
    "high confidence on a market-wide story alone is refused",
    bad((d) => ({
      ...d,
      movements: [{ ...d.movements[0], citations: ["A3"], confidence: "high" }, d.movements[1]],
    })),
    "filed against XAU",
  );

  // Anti-fabrication. A plausible invented figure is the failure a reader cannot
  // catch, so the numbers are checked against the ones we handed over.
  // Two movements, each with a session move, a weekly move and its own sigma,
  // plus the market's own weekly figure. Nothing else is quotable.
  eq("the supported figures are the ones we gave", supportedFigures(pack).length, 7);
  rejects(
    "a figure we never supplied is refused",
    bad((d) => ({ ...d, summary: `${d.summary} Gold is down 12.7% on the month.` })),
    "12.7%",
  );
  rejects(
    "…including one buried in an inference",
    bad((d) => ({
      ...d,
      movements: [{ ...d.movements[0], inference: "Gold fell 9.9% on the session." }, d.movements[1]],
    })),
    "9.9%",
  );
  rejects(
    "…and one in a watch item",
    bad((d) => ({ ...d, watchItems: ["Whether gold recovers its 8.8% loss"] })),
    "8.8%",
  );
  ok(
    "a rounded figure is fine — that is good writing, not fabrication",
    validateInsight({ ...goodDraft(), summary: "Gold fell 3.4% on the session." }, pack).ok,
  );
  ok(
    "…as is an unsigned one",
    validateInsight({ ...goodDraft(), summary: "Silver rose 5.24% on the session." }, pack).ok,
  );

  rejects(
    "an unknown verdict is refused",
    bad((d) => ({
      ...d,
      movements: [{ ...d.movements[0], verdict: "certain" as InsightDraft["movements"][number]["verdict"] }, d.movements[1]],
    })),
    "use one of",
  );
  rejects(
    "an over-long headline is refused",
    bad((d) => ({ ...d, headline: "x".repeat(LIMITS.headline + 1) })),
    "keep it under",
  );
  rejects(
    "too many watch items are refused",
    bad((d) => ({ ...d, watchItems: ["a", "b", "c", "d", "e"] })),
    "keep it to",
  );
  rejects(
    "an empty answer is refused",
    bad((d) => ({ ...d, headline: "", summary: "" })),
    "missing or empty",
  );
  ok("a non-object is refused without throwing", validateInsight("nope", pack).ok === false);

  // Answers come back in whatever order the model wrote them; the reader gets the
  // order the facts were presented in.
  const reordered = validateInsight(
    { ...goodDraft(), movements: [goodDraft().movements[1], goodDraft().movements[0]] },
    pack,
  );
  ok("readings are returned in the brief's order", reordered.ok && reordered.value.movements[0].ref === "M1");

  // `hasSomethingToExplain` means a pack with no movements never reaches the model,
  // but the validator stays total: an empty answer to an empty brief is coherent,
  // and one that invents movements for it is exactly what got caught in the wild.
  const noMovers: EvidencePack = { ...pack, movements: [] };
  ok(
    "an empty brief accepts an empty answer",
    validateInsight(
      { headline: "A quiet week", summary: "Coverage was macro-led.", movements: [], watchItems: [] },
      noMovers,
    ).ok,
  );
  const invented = validateInsight(
    { ...goodDraft(), movements: [{ ...goodDraft().movements[0], ref: "M1" }] },
    noMovers,
  );
  rejects(
    "…and refuses one that invents a movement for it",
    invented.ok ? [] : invented.errors,
    "not in the FACTS block",
  );
}

/* ------------------------------------------------------------------ status */

function checkStatus() {
  section("What 'insufficient' means");

  // The word has to mean one thing: things moved and nothing explained them. A
  // quiet week with no unusual moves is not insufficient — there was nothing to be
  // insufficient about — and conflating the two would make the field useless for
  // deciding what to surface.
  eq("a week with nothing unusual is not 'insufficient'", statusFor([]), "ok");
  eq(
    "…nor is one where something was accounted for",
    statusFor([{ verdict: "insufficient" }, { verdict: "partial" }]),
    "ok",
  );
  eq(
    "…but a week where nothing was accounted for is",
    statusFor([{ verdict: "insufficient" }, { verdict: "insufficient" }]),
    "insufficient",
  );
  eq(
    "…as is a single unexplained move",
    statusFor([{ verdict: "insufficient" }]),
    "insufficient",
  );
}

/* -------------------------------------------------------------- resolving */

function checkResolve() {
  section("Resolving citations for display");

  const pack = samplePack();
  const draft = goodDraft();
  const readings = resolveReadings(draft, pack);

  eq("every reading keeps its fact", readings[0].fact.symbol, "XAU");
  eq("…and its citation, copied in", readings[0].sources[0].title, pack.articles[0].title);
  eq("…with a link to the publisher", readings[0].sources[0].url, "https://example.com/gold-1");
  eq("…and how it was linked to this asset", readings[0].sources[0].via, "feed");

  // The snapshot is why an insight survives its sources being pruned.
  ok("a citation carries its own date", readings[0].sources[0].publishedAt instanceof Date);

  // An article filed against gold that merely mentions silver is `feed` for one
  // and nothing for the other; the reader is owed that difference.
  const crossCited = resolveReadings(
    { ...draft, movements: [{ ...draft.movements[0], citations: ["A3"] }, draft.movements[1]] },
    pack,
  );
  eq("a market-wide citation is marked as linked to nothing", crossCited[0].sources[0].via, null);
}

/* ------------------------------------------------------------- json + loop */

function checkJson() {
  section("Reading a model's answer");

  eq("bare JSON parses", (parseJsonAnswer('{"a":1}') as { a: number }).a, 1);
  eq(
    "a fenced answer parses",
    (parseJsonAnswer('```json\n{"a":2}\n```') as { a: number }).a,
    2,
  );
  eq(
    "prose around the object parses",
    (parseJsonAnswer('Sure! {"a":3} Hope that helps.') as { a: number }).a,
    3,
  );
  let threw: unknown = null;
  try {
    parseJsonAnswer("no json here");
  } catch (e) {
    threw = e;
  }
  ok("an answer with no object is a rejection, not a crash", threw instanceof NotJsonError);
  try {
    parseJsonAnswer("");
  } catch (e) {
    threw = e;
  }
  ok("…as is an empty one", threw instanceof NotJsonError);
}

async function checkLoop() {
  section("The ask-validate-repair loop");

  const pack = samplePack();
  const task = (provider: AiProvider) => ({
    system: SYSTEM_PROMPT,
    request: buildRequest(pack),
    schema: INSIGHT_SCHEMA,
    schemaName: "market_insight",
    maxTokens: 8000,
    provider,
    review: (draft: unknown) => {
      const checked = validateInsight(draft, pack);
      return checked.ok
        ? ({ ok: true, value: checked.value } as const)
        : ({ ok: false, errors: checked.errors, repair: buildRepair(checked.errors) } as const);
    },
  });

  const good = JSON.stringify(goodDraft());
  const first = scriptedProvider([good]);
  const straight = await runStructuredTask(task(first.provider));
  eq("a valid answer is accepted first time", straight.attempts, 1);
  eq("…credited to the backend that wrote it", straight.model, "scripted");
  eq("…named under the schema the backend needs", first.asks[0].schemaName, "market_insight");

  // The repair turn is the whole reason a small local model converges at all.
  const invented = JSON.stringify({ ...goodDraft(), summary: "Gold fell 12.7% this week." });
  const second = scriptedProvider([invented, good]);
  const rejections: string[][] = [];
  const repaired = await runStructuredTask({
    ...task(second.provider),
    onRejected: ({ errors }) => rejections.push(errors),
  });
  eq("an invented figure costs an attempt", repaired.attempts, 2);
  ok("…and is reported", rejections[0]?.some((e) => e.includes("12.7%")) === true);
  const repairTurn = second.asks[1].turns.at(-1)?.text ?? "";
  ok("…with the complaint handed back verbatim", repairTurn.includes("12.7%"));
  eq("…as a third turn, so the model sees its own answer", second.asks[1].turns.length, 3);

  const hopeless = scriptedProvider([invented]);
  let refused: unknown = null;
  try {
    await runStructuredTask(task(hopeless.provider));
  } catch (e) {
    refused = e;
  }
  ok("three bad answers store nothing", refused instanceof StructuredTaskError);
  eq("…after exactly three attempts", (refused as StructuredTaskError)?.attempts, 3);
  eq("…having asked three times", hopeless.asks.length, 3);
}

/* ------------------------------------------------------------------- run */

async function main() {
  checkWeeks();
  checkSchema();
  checkEvidence();
  checkRender();
  checkPrompt();
  checkValidator();
  checkStatus();
  checkResolve();
  checkJson();
  await checkLoop();

  if (failures > 0) {
    console.error(`\nFAILED — ${failures} of ${checks} checks failed.`);
    process.exit(1);
  }
  console.log(`\nPASS — ${checks}/${checks} checks passed.`);
}

main();
