/**
 * Which headlines are about which assets, and which assets are worth asking about.
 *
 * Two questions, both answered here because they are the same decision seen from
 * either end: `newsworthy` picks the assets whose move needs explaining, and
 * `matchArticle` decides whether what came back actually explains them.
 *
 * The design rule throughout: a match is *scored and attributed*, never asserted.
 * Every match records how it was made, so nothing downstream — least of all a
 * language model in Phase D — has to treat "this article mentions gold" and "this
 * article came from the gold feed" as the same class of evidence. One is a
 * coincidence waiting to happen; the other is provenance.
 *
 * Pure — no Prisma, no fetch, no provider vocabulary.
 */
import { unusualMove } from "@/lib/markets/performance";
import type { AssetRef, BarData, Market } from "@/lib/markets/types";
import { assetTerms, hasOwnStory } from "./terms";
import type { MatchVia, NewsMatch } from "./types";

/* ------------------------------------------------------------------ scoring */

/**
 * Base confidence per signal.
 *
 * `feed` is 1 and stands alone: the article was returned by a feed scoped to
 * that instrument, so the publisher — not this file's guesswork — asserted the
 * connection. Everything below it is text matching, and text matching is how
 * "Visa" ends up attached to a story about immigration.
 */
const BASE: Record<MatchVia, number> = {
  feed: 1,
  symbol: 0.8,
  name: 0.65,
  alias: 0.55,
};

/**
 * A hit in the standfirst counts, but for less than one in the headline.
 *
 * The value is chosen against `MIN_SCORE` rather than picked for feel, because
 * together they decide which signals survive at all:
 *
 *   feed                 1.00  ✓   provenance
 *   symbol, headline     0.80  ✓
 *   symbol, standfirst   0.56  ✓   a ticker in the body is a deliberate mention
 *   name,   headline     0.65  ✓
 *   name,   standfirst   0.455 ✓   "Markets wrap: Apple led the tape"
 *   alias,  headline     0.55  ✓
 *   alias,  standfirst   0.385 ✗   below the line, on purpose
 *
 * That last exclusion is the point of the gradient: a hand-written synonym is
 * already the loosest signal here, and one buried in body text is how "gold"
 * attaches itself to a story about medals.
 */
const SUMMARY_WEIGHT = 0.7;

/**
 * Corroboration from the feed the article arrived on: "gold" in a story pulled
 * from the commodities feed is likelier to be the metal than "gold" anywhere else.
 */
const MARKET_BONUS = 0.1;

/** Below this, a match is noise and is not stored. */
export const MIN_SCORE = 0.4;

/* ----------------------------------------------------------------- matching */

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiled patterns, keyed by term and case-sensitivity.
 *
 * One ingest matches a couple of hundred articles against every tracked asset's
 * name, ticker and synonyms — hundreds of thousands of tests over a few hundred
 * distinct terms. Compiling each pattern once is the difference between a
 * noticeable pause and no pause at all. The key set is bounded by the catalogue,
 * so this cannot grow without bound.
 */
const PATTERNS = new Map<string, RegExp>();

function pattern(term: string, caseInsensitive: boolean): RegExp {
  const key = `${caseInsensitive ? "i" : "s"}:${term}`;
  let re = PATTERNS.get(key);
  if (!re) {
    re = new RegExp(
      `(?<![A-Za-z0-9])${escapeRe(term)}(?![A-Za-z0-9])`,
      caseInsensitive ? "i" : "",
    );
    PATTERNS.set(key, re);
  }
  return re;
}

/**
 * A phrase, on word boundaries, case-insensitively.
 *
 * `\b` is not usable here: half these phrases begin or end with a character that
 * is not a word character ("S&P", "10-year Treasury"), and `\b` is defined
 * relative to word characters, so it would silently stop matching. Explicit
 * alphanumeric lookaround says what is actually meant — "not in the middle of a
 * longer word" — for every phrase regardless of its punctuation.
 */
export function containsPhrase(haystack: string, phrase: string): boolean {
  if (!phrase) return false;
  return pattern(phrase, true).test(haystack);
}

/**
 * A ticker, as a standalone uppercase token.
 *
 * Case-sensitive on purpose, and it is doing real work: it is the difference
 * between a headline about Costco and one about the cost of anything.
 */
export function containsSymbol(haystack: string, symbol: string): boolean {
  if (!symbol) return false;
  return pattern(symbol, false).test(haystack);
}

/** The article fields matching looks at. */
export interface MatchableArticle {
  title: string;
  summary: string | null;
  /** The market whose feed produced it, if any. */
  market: Market | null;
}

export interface MatchOptions {
  /** The asset whose own feed returned this article — provenance, not text. */
  feedAssetId?: string;
  minScore?: number;
}

/**
 * Attach an article to every asset it plausibly concerns.
 *
 * One asset yields at most one match: the strongest signal wins, so a story that
 * names both "Apple" and "AAPL" is one confident match rather than two weak ones.
 * Results are ranked, strongest first.
 */
export function matchArticle(
  article: MatchableArticle,
  assets: AssetRef[],
  options: MatchOptions = {},
): NewsMatch[] {
  const minScore = options.minScore ?? MIN_SCORE;
  const title = article.title;
  const summary = article.summary ?? "";
  const best = new Map<string, NewsMatch>();

  const offer = (assetId: string, via: MatchVia, inTitle: boolean, market: Market | null) => {
    let score = BASE[via] * (inTitle ? 1 : SUMMARY_WEIGHT);
    if (article.market && market && article.market === market) score += MARKET_BONUS;
    score = Math.min(1, score);
    if (score < minScore) return;
    const existing = best.get(assetId);
    if (!existing || score > existing.score) best.set(assetId, { assetId, score, via });
  };

  for (const asset of assets) {
    if (options.feedAssetId === asset.id) {
      offer(asset.id, "feed", true, asset.market);
      continue;
    }

    const terms = assetTerms(asset);

    for (const symbol of terms.symbols) {
      if (containsSymbol(title, symbol)) offer(asset.id, "symbol", true, asset.market);
      else if (containsSymbol(summary, symbol)) offer(asset.id, "symbol", false, asset.market);
    }

    // The catalogue name is a stronger claim than a hand-written synonym, so it
    // is offered under its own `via` and outranks an alias hit on the same asset.
    if (containsPhrase(title, asset.name)) offer(asset.id, "name", true, asset.market);
    else if (containsPhrase(summary, asset.name)) offer(asset.id, "name", false, asset.market);

    for (const alias of terms.aliases) {
      if (alias === asset.name) continue;
      if (containsPhrase(title, alias)) offer(asset.id, "alias", true, asset.market);
      else if (containsPhrase(summary, alias)) offer(asset.id, "alias", false, asset.market);
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score);
}

/* -------------------------------------------------------------- newsworthy */

/**
 * An asset whose latest session is far enough from its own habits to want an
 * explanation.
 */
export interface NewsCandidate {
  asset: AssetRef;
  /** The latest session's move, in percent. */
  changePct: number;
  /** The asset's own daily volatility over the lookback, in percent. */
  sigma: number;
  /** How many of its own standard deviations that move was. Signed. */
  zScore: number;
}

export interface NewsworthyOptions {
  /** Standard deviations from an asset's own norm before it counts as unusual. */
  minZ?: number;
  /** Most candidates to return. Each one costs a feed request and, later, tokens. */
  limit?: number;
}

/**
 * Rank assets by how unusual their latest move was.
 *
 * The threshold is in units of the asset's *own* volatility, not percent: a 3%
 * day is a shrug for a small-cap and a genuine event for a Treasury yield, and a
 * fixed percentage cutoff would spend every news lookup on whatever happens to be
 * the most volatile thing in the catalogue. `unusualMove` excludes the day being
 * judged from the deviation it is judged against, so a single violent session
 * cannot normalise itself.
 *
 * Assets with no story of their own — index levels, bond yields — are left out:
 * they move because the market did, and the market-level query already covers it.
 */
export function newsworthy(
  entries: { asset: AssetRef; bars: BarData[] }[],
  options: NewsworthyOptions = {},
): NewsCandidate[] {
  const minZ = options.minZ ?? 2;
  const limit = options.limit ?? 10;

  const candidates: NewsCandidate[] = [];
  for (const { asset, bars } of entries) {
    if (!hasOwnStory(asset)) continue;
    const move = unusualMove(bars);
    if (!move || Math.abs(move.zScore) < minZ) continue;
    candidates.push({
      asset,
      changePct: move.changePct,
      sigma: move.sigma,
      zScore: move.zScore,
    });
  }

  // Direction is not the point — a crash needs explaining exactly as much as a
  // spike does — so rank on magnitude.
  return candidates.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore)).slice(0, limit);
}
