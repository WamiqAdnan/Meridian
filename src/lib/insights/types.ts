/**
 * The vocabulary of a weekly market insight.
 *
 * One distinction runs through every type here and is the reason the file is
 * shaped the way it is: a **fact** is computed from stored price data and is true;
 * an **inference** is what a language model made of some headlines and is not. They
 * are separate fields, they are stored separately, and they are rendered
 * separately. Nothing in this layer is allowed to blur them — an insight that says
 * "gold fell because the dollar firmed" as a single sentence has already lost the
 * property that makes it safe to show.
 *
 * The model never sees prices it can quote freely, either. It sees a fixed list of
 * numbered movements and a fixed list of numbered headlines, and it answers by
 * *reference*. Everything it writes is checked back against those lists.
 *
 * Pure types and pure functions. No Prisma, no fetch.
 */
import type { Market } from "@/lib/markets/types";
import type { MatchVia } from "@/lib/news/types";

/* -------------------------------------------------------------- the facts */

/**
 * One movement worth explaining — a fact, computed from daily closes.
 *
 * `ref` is a short handle ("M1") rather than an asset id: it is what the model
 * cites, and a small local model is markedly better at carrying "M1" through a
 * paragraph than "commodities:XAU". It also makes every citation trivially
 * checkable.
 */
export interface MovementFact {
  ref: string;
  assetId: string;
  symbol: string;
  name: string;
  market: Market;
  currency: string;
  /** The latest session's move, in percent. */
  changePct: number;
  /** The asset's own daily volatility over the lookback, in percent. */
  sigma: number;
  /** How many of its own standard deviations that move was. Signed. */
  zScore: number;
  /** The move over the week, in percent. Null when the series cannot cover it. */
  weekChangePct: number | null;
  /** Latest close, in the asset's own currency. */
  price: number | null;
  /** The date of that close. */
  asOf: string | null;
}

/** One headline offered as evidence, with how it came to be linked. */
export interface EvidenceArticle {
  ref: string;
  articleId: string;
  title: string;
  /** The standfirst, where the feed carried one. Never an article body. */
  summary: string | null;
  /** The publisher — "Reuters", "CNBC". */
  source: string;
  url: string;
  publishedAt: Date;
  /**
   * Which movements this article is attached to, and how strong that attachment
   * is. An article with no links is not useless — a market-wide story explains a
   * move without ever naming the instrument — but it can never be strong evidence
   * about one asset.
   */
  links: { ref: string; assetId: string; via: MatchVia; score: number }[];
}

/**
 * Everything the model is given. Nothing else reaches it.
 *
 * Built by `evidence.ts` from what Phase C already produces: `newsworthyAssets`
 * decides what needs explaining, `listNews` supplies what might explain it.
 */
export interface EvidencePack {
  market: Market;
  /** Monday of the week this insight covers, yyyy-mm-dd. */
  weekStart: string;
  /** The latest session any of these movements is measured to. */
  asOf: string | null;
  movements: MovementFact[];
  articles: EvidenceArticle[];
  /** The market's own move over the week, in percent. */
  marketChangePct: number | null;
  /** What the market's own move is measured on — its headline asset, or its median. */
  marketBasis: string;
  advancers: number;
  decliners: number;
  assetsTracked: number;
}

/* ----------------------------------------------------------- the inference */

/**
 * How well the retrieved headlines account for a movement.
 *
 * `insufficient` is a first-class answer, not a failure. It is the honest one most
 * weeks, and the validator makes it the *cheap* one: an `explained` verdict has to
 * cite evidence, an `insufficient` one has to cite none.
 */
export const VERDICTS = ["explained", "partial", "insufficient"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** The model's answer about one movement, still in refs. */
export interface MovementReading {
  ref: string;
  verdict: Verdict;
  /** What the cited headlines suggest. An inference, never stated as a cause. */
  inference: string;
  /** Article refs. Empty when the verdict is `insufficient`. */
  citations: string[];
  confidence: Confidence;
}

/** The model's whole answer, shaped by `INSIGHT_SCHEMA`. */
export interface InsightDraft {
  headline: string;
  summary: string;
  movements: MovementReading[];
  watchItems: string[];
}

/* ------------------------------------------------------------- the record */

/**
 * A citation with the headline it points at, copied in.
 *
 * Snapshotted rather than joined: news is pruned after ninety days and an insight
 * has to stay readable — and auditable — long after the story it cites has gone.
 */
export interface ResolvedCitation {
  ref: string;
  title: string;
  url: string;
  source: string;
  publishedAt: Date;
  /** How this article was linked to the asset, or null if it was linked to none. */
  via: MatchVia | null;
}

/** One movement, its fact and its reading side by side — how it is rendered. */
export interface ResolvedReading extends MovementReading {
  fact: MovementFact;
  sources: ResolvedCitation[];
}

/**
 * A stored insight, complete on its own.
 *
 * This is the JSON in `MarketInsight.body`. It carries the facts as computed at
 * generation time rather than recomputing them on read, because an insight is a
 * statement about a week, and the week's numbers do not change afterwards.
 */
export interface InsightBody {
  headline: string;
  summary: string;
  watchItems: string[];
  readings: ResolvedReading[];
  asOf: string | null;
  marketChangePct: number | null;
  marketBasis: string;
  advancers: number;
  decliners: number;
  assetsTracked: number;
  /** How many headlines were on the table, cited or not. */
  articlesConsidered: number;
}

/**
 * Whether an insight found anything to say.
 *
 * `insufficient` means it was generated honestly and came back empty-handed — a
 * quiet week, or headlines that explain nothing. It is displayed, not hidden.
 */
export const INSIGHT_STATUSES = ["ok", "insufficient"] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

export interface StoredInsight {
  market: Market;
  weekStart: string;
  generatedAt: Date;
  /** Which backend wrote it. */
  model: string;
  status: InsightStatus;
  headline: string;
  body: InsightBody;
}

/**
 * How many movements an insight actually accounted for.
 *
 * The honest headline number: "0 of 2" is the answer most weeks, and showing it is
 * what stops the panel reading as though it explained more than it did.
 */
export function accountedFor(insight: StoredInsight): { explained: number; total: number } {
  const readings = insight.body.readings;
  return {
    explained: readings.filter((r) => r.verdict !== "insufficient").length,
    total: readings.length,
  };
}

/* ----------------------------------------------------------------- weeks */

/**
 * The Monday of the week containing `date`, in UTC.
 *
 * Weeks are the unit an insight is cached on, so this has to be stable: two calls
 * on the same Thursday must produce the same key, or the cache never hits and
 * every page view costs a model call.
 */
export function weekStartOf(date: Date | string = new Date()): string {
  const d =
    typeof date === "string" ? new Date(`${date.slice(0, 10)}T00:00:00Z`) : new Date(date);
  // getUTCDay is 0 for Sunday; shift so Monday is 0.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** The last instant of a yyyy-mm-dd day, in UTC — where a week's window ends. */
export function endOfDay(date: string): Date {
  return new Date(`${date}T23:59:59.999Z`);
}

/** The Sunday that closes the week starting at `weekStart`. */
export function weekEndOf(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}
