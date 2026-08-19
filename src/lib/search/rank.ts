/**
 * Which asset a typed phrase means.
 *
 * Pure — no Prisma, no fetch, no `window`. Hand it candidates and a query and it
 * answers with an ordered list; `store.ts` is the seam that loads the candidates.
 *
 * Two decisions shape the whole file:
 *
 *   - **A hit says which field it matched.** "AAPL" found by ticker and "bullion"
 *     found by a hand-written synonym are both correct answers, but a reader
 *     picking from a dropdown deserves to know which happened — the same reason
 *     `NewsMatch.via` is carried through the news layer rather than collapsed into
 *     a score. `MATCH_LABEL` is the wording.
 *   - **The tiers are further apart than any bonus.** Every score below comes from
 *     a fixed table with at least `TIER_GAP` between neighbouring tiers, so the
 *     held-position bonus can reorder two equally-matched assets without ever
 *     lifting a weaker kind of match above a stronger one. A ticker match always
 *     outranks a substring, whatever you own.
 *
 * The ranking is a total order — score, then catalogue rank, then market, then
 * symbol — so the same query gives the same answer on every run, which is what
 * makes `npm run check:search` worth writing.
 */
import { MARKETS, MARKET_META, type AssetKind, type AssetRef, type Market } from "@/lib/markets/types";
import { assetTerms } from "@/lib/news/terms";

/* ------------------------------------------------------------------ fields */

/** How a candidate came to match. Ordered strongest-first. */
export const MATCH_FIELDS = ["id", "symbol", "name", "alias", "market"] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

/** How a match is described to a reader, in the words the dropdown uses. */
export const MATCH_LABEL: Record<MatchField, string> = {
  id: "asset id",
  symbol: "ticker",
  name: "name",
  alias: "also called",
  market: "market",
};

/* -------------------------------------------------------------- candidates */

/** An asset as the ranker needs it. Everything here is display-ready. */
export interface SearchCandidate {
  id: string;
  market: Market;
  marketLabel: string;
  symbol: string;
  name: string;
  kind: AssetKind;
  currency: string;
  /** Catalogue rank — the tie-break between two equally good matches. */
  rank: number;
  /**
   * Synonyms a headline would use: "bullion", "the Dow", "greenback".
   *
   * Taken from `news/terms.ts` rather than written again here, so a phrase that
   * finds an asset in the search box is the same phrase that attaches a story to
   * it. Two lists would drift, and the drift would be invisible.
   */
  aliases: string[];
}

export function toCandidate(asset: AssetRef): SearchCandidate {
  const { aliases } = assetTerms(asset);
  const lowerName = asset.name.toLowerCase();
  return {
    id: asset.id,
    market: asset.market,
    marketLabel: MARKET_META[asset.market].label,
    symbol: asset.symbol,
    name: asset.name,
    kind: asset.kind,
    currency: asset.currency,
    rank: asset.rank,
    // The name is already matched as a name; carrying it again as an alias would
    // only let a weaker tier claim a hit the stronger one already has.
    aliases: aliases.filter((a) => a.toLowerCase() !== lowerName),
  };
}

/* ----------------------------------------------------------------- scoring */

/**
 * What each kind of match is worth.
 *
 * The numbers are not feel — they are an evenly spaced ladder, and the *rungs*
 * are the claim: an exact ticker beats an exact name, which beats a synonym,
 * which beats any partial. Within a kind, leading the field beats starting a word
 * inside it, which beats appearing anywhere in it.
 *
 * Spacing them evenly at `TIER_GAP` is what makes the ordering safe to reason
 * about. A hand-tuned table drifts — the first draft of this one put an exact
 * ticker 0.02 below an exact id, which the held-position bonus could bridge, so
 * owning an asset could have promoted a substring match. The checks assert the
 * spacing, not the values.
 */
export const SCORE = {
  idExact: 1,
  symbolExact: 0.94,
  nameExact: 0.88,
  aliasExact: 0.82,
  symbolPrefix: 0.76,
  namePrefix: 0.7,
  aliasPrefix: 0.64,
  /** The query starts a word inside the field, but not the field itself. */
  nameWord: 0.58,
  aliasWord: 0.52,
  symbolInfix: 0.46,
  nameInfix: 0.4,
  marketLabel: 0.34,
} as const;

/** The distance between neighbouring tiers. Asserted by the checks. */
export const TIER_GAP = 0.06;

/**
 * What holding something is worth in the ranking.
 *
 * Smaller than `TIER_GAP` on purpose: owning an asset should decide a tie, never
 * promote a substring match over a ticker match.
 */
export const HELD_BONUS = 0.03;

/** Below this a match is noise. The weakest real tier is `marketLabel`. */
export const MIN_SCORE = 0.25;

/** A multi-word query is a weaker signal than the same phrase matching whole. */
export const MULTI_WORD_FACTOR = 0.9;

/**
 * Partial matching needs at least two characters.
 *
 * A single letter legitimately names an asset — `V` is Visa — so an *exact*
 * ticker match still counts at one character. Letting one character match
 * *inside* a field would return half the catalogue ranked by accident.
 */
const MIN_PARTIAL = 2;

export interface SearchHit {
  candidate: SearchCandidate;
  score: number;
  /** Which field matched. */
  field: MatchField;
  /** The text that matched — what the dropdown shows next to the label. */
  matched: string;
  /** Whether this asset is in the ledger. Boosts the score and is worth showing. */
  held: boolean;
}

type FieldHit = { score: number; field: MatchField; matched: string };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `query` start a word inside `haystack`, other than the first?
 *
 * Word-*start* rather than whole-word: typing "micr" should find "Advanced Micro
 * Devices" long before the word is finished, which is the entire point of a
 * typeahead. Both strings are already lowercased.
 */
function startsWordInside(haystack: string, query: string): boolean {
  return new RegExp(`[^a-z0-9]${escapeRe(query)}`).test(haystack);
}

/** Normalize a query or a field to one comparable form. */
export function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Score one already-normalized query against one candidate, or null for no match.
 *
 * Checked strongest-tier-first and returns on the first hit, so a candidate is
 * only ever credited with its best kind of match.
 */
function scoreField(query: string, candidate: SearchCandidate): FieldHit | null {
  const partial = query.length >= MIN_PARTIAL;
  const id = candidate.id.toLowerCase();
  const symbol = candidate.symbol.toLowerCase();
  const name = candidate.name.toLowerCase();

  if (id === query) return { score: SCORE.idExact, field: "id", matched: candidate.id };
  if (symbol === query) return { score: SCORE.symbolExact, field: "symbol", matched: candidate.symbol };
  if (name === query) return { score: SCORE.nameExact, field: "name", matched: candidate.name };

  const aliases = candidate.aliases.map((a) => ({ text: a, lower: a.toLowerCase() }));
  const aliasExact = aliases.find((a) => a.lower === query);
  if (aliasExact) return { score: SCORE.aliasExact, field: "alias", matched: aliasExact.text };

  if (symbol.startsWith(query)) {
    return { score: SCORE.symbolPrefix, field: "symbol", matched: candidate.symbol };
  }
  if (name.startsWith(query)) {
    return { score: SCORE.namePrefix, field: "name", matched: candidate.name };
  }
  const aliasPrefix = aliases.find((a) => a.lower.startsWith(query));
  if (aliasPrefix) return { score: SCORE.aliasPrefix, field: "alias", matched: aliasPrefix.text };

  if (!partial) return null;

  if (startsWordInside(name, query)) {
    return { score: SCORE.nameWord, field: "name", matched: candidate.name };
  }
  const aliasWord = aliases.find((a) => startsWordInside(a.lower, query));
  if (aliasWord) return { score: SCORE.aliasWord, field: "alias", matched: aliasWord.text };

  if (symbol.includes(query)) {
    return { score: SCORE.symbolInfix, field: "symbol", matched: candidate.symbol };
  }
  if (name.includes(query)) {
    return { score: SCORE.nameInfix, field: "name", matched: candidate.name };
  }

  // The market is the weakest field and deliberately the last one tried: "crypto"
  // should surface Bitcoin by name before it surfaces the whole crypto market.
  const marketLabel = candidate.marketLabel.toLowerCase();
  if (marketLabel === query || marketLabel.startsWith(query) || startsWordInside(marketLabel, query)) {
    return { score: SCORE.marketLabel, field: "market", matched: candidate.marketLabel };
  }
  return null;
}

/**
 * Score a multi-word query: every word has to land somewhere.
 *
 * "apple stock" and "us dollar rupee" are real things to type, and neither
 * matches any single field whole. Requiring every word is what stops "apple
 * stock" also returning every other equity — `stock` alone matches most of the
 * catalogue, and an any-word rule would rank on the noise.
 *
 * The reported field is the strongest of the per-word hits, because that is the
 * one worth telling the reader about.
 */
function scoreWords(words: string[], candidate: SearchCandidate): FieldHit | null {
  let total = 0;
  let best: FieldHit | null = null;
  for (const word of words) {
    const hit = scoreField(word, candidate);
    if (!hit) return null;
    total += hit.score;
    if (!best || hit.score > best.score) best = hit;
  }
  if (!best) return null;
  return { ...best, score: (total / words.length) * MULTI_WORD_FACTOR };
}

/* ----------------------------------------------------------------- ranking */

export interface RankOptions {
  /** Most hits to return. 0 means every hit above `MIN_SCORE`. */
  limit?: number;
  /** Asset ids the ledger refers to — they win ties against anything else. */
  heldIds?: ReadonlySet<string>;
}

export const DEFAULT_LIMIT = 10;

const MARKET_ORDER = new Map<Market, number>(MARKETS.map((m, i) => [m, i]));

/**
 * Rank candidates against a query, best first.
 *
 * The comparison is a total order and every term of it is deterministic, so two
 * runs over the same catalogue cannot disagree — no timestamps, no insertion
 * order, no `Math.random`.
 */
export function rankAssets(
  query: string,
  candidates: readonly SearchCandidate[],
  options: RankOptions = {},
): SearchHit[] {
  const q = normalize(query);
  if (!q) return [];

  const words = q.split(" ");
  const held = options.heldIds ?? new Set<string>();

  const hits: SearchHit[] = [];
  for (const candidate of candidates) {
    // The whole phrase first: "US Dollar Index" typed in full is a name match,
    // not three word matches, and should score as one.
    const hit =
      scoreField(q, candidate) ??
      (words.length > 1 && words.every((w) => w.length >= MIN_PARTIAL)
        ? scoreWords(words, candidate)
        : null);
    if (!hit || hit.score < MIN_SCORE) continue;

    const isHeld = held.has(candidate.id);
    hits.push({
      candidate,
      // Capped so a held exact-id match cannot exceed 1 and break the scale.
      score: Math.min(1, hit.score + (isHeld ? HELD_BONUS : 0)),
      field: hit.field,
      matched: hit.matched,
      held: isHeld,
    });
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      a.candidate.rank - b.candidate.rank ||
      (MARKET_ORDER.get(a.candidate.market) ?? 0) - (MARKET_ORDER.get(b.candidate.market) ?? 0) ||
      (a.candidate.symbol < b.candidate.symbol ? -1 : a.candidate.symbol > b.candidate.symbol ? 1 : 0) ||
      (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0),
  );

  const limit = options.limit ?? DEFAULT_LIMIT;
  return limit > 0 ? hits.slice(0, limit) : hits;
}
