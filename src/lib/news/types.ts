/**
 * The vocabulary the news layer shares.
 *
 * Deliberately shaped after `markets/types.ts`, because the problem is the same
 * one: several unrelated upstreams, none of them authoritative, none of them
 * allowed to leak their vocabulary into the rest of the app. A `NewsProvider` is
 * to a headline what a `MarketDataProvider` is to a price.
 *
 * One difference from the market layer, and it is deliberate — see
 * `news/registry.ts`: market data *falls back* between providers, because a
 * second opinion on a price is redundant. News *unions* them, because two
 * publishers covering the same move is the entire point.
 *
 * Pure types and pure functions only. No Prisma, no fetch.
 */
import type { AssetRef, Market } from "@/lib/markets/types";

/* ------------------------------------------------------------------ article */

/**
 * One headline, after a provider has been normalised away.
 *
 * `id` is a hash of the canonical URL rather than a provider's own guid: the
 * same story reaches us from Yahoo and from Google News under two different
 * guids, and deduping on the URL is what stops it being stored twice.
 */
export interface NewsArticle {
  id: string;
  title: string;
  /** Canonical URL — tracking parameters stripped. The identity of the article. */
  url: string;
  /** Who published it: "Reuters", "CNBC". Distinct from `provider`. */
  source: string;
  /** Which NewsProvider fetched it: yahoo | google | cnbc. */
  provider: string;
  /** The standfirst, tags stripped. Null when the feed carried none worth keeping. */
  summary: string | null;
  publishedAt: Date;
  /**
   * The market whose feed produced this article, when the query was scoped to
   * one. Null for a general market-wide story — which is not a gap: a Fed
   * decision belongs to every market, and pinning it to one would be a guess.
   */
  market: Market | null;
}

/* ------------------------------------------------------------------ queries */

/**
 * What a provider is being asked for.
 *
 * Three kinds, because there are three genuinely different questions:
 * "what happened to this instrument", "what happened in this market", and
 * "what happened at all". A provider answers the ones it can and declines the
 * rest via `supports`.
 */
export const NEWS_QUERY_KINDS = ["asset", "market", "topic"] as const;
export type NewsQueryKind = (typeof NEWS_QUERY_KINDS)[number];

export interface NewsQuery {
  kind: NewsQueryKind;
  /** Set when kind is "asset". */
  asset?: AssetRef;
  /** Set when kind is "market", and on an "asset" query for the asset's market. */
  market?: Market;
  /** Set when kind is "topic" — a free-text phrase. */
  topic?: string;
  /** Ignore anything published before this yyyy-mm-dd. */
  since?: string;
  /** Most articles to keep from one feed. */
  limit?: number;
}

export function assetQuery(asset: AssetRef, over: Partial<NewsQuery> = {}): NewsQuery {
  return { kind: "asset", asset, market: asset.market, ...over };
}

export function marketQuery(market: Market, over: Partial<NewsQuery> = {}): NewsQuery {
  return { kind: "market", market, ...over };
}

export function topicQuery(topic: string, over: Partial<NewsQuery> = {}): NewsQuery {
  return { kind: "topic", topic, ...over };
}

/**
 * A stable label for one query — used to dedup a work list and to name a query
 * in a run's audit row. Two queries with the same key ask the same question.
 */
export function queryKey(q: NewsQuery): string {
  switch (q.kind) {
    case "asset":
      return `asset:${q.asset?.id ?? "?"}`;
    case "market":
      return `market:${q.market ?? "?"}`;
    default:
      return `topic:${(q.topic ?? "?").toLowerCase()}`;
  }
}

/* ---------------------------------------------------------------- providers */

/**
 * What one provider returns for one query. Mirrors `ProviderQuoteResult`: a
 * provider reports its own failures per-query rather than throwing, so one dead
 * feed never costs a whole ingest.
 */
export interface NewsFetchResult {
  query: NewsQuery;
  articles: NewsArticle[];
  error: string | null;
}

/** A source of headlines. */
export interface NewsProvider {
  readonly id: string;
  readonly label: string;
  /**
   * Whether an asset-scoped feed from this provider is *editorial* rather than a
   * text search.
   *
   * The distinction is load-bearing. Yahoo files each story against the symbols
   * it concerns, so an article from `?s=AAPL` is about Apple because a publisher
   * said so. Google News takes the same request as a search phrase and returns
   * whatever ranks — which, asked about the UAE dirham, returns pages of crypto
   * converter spam. Treating those two as the same evidence is how a confident
   * insight gets built on a listing for "Convert 10 MEGA to AED".
   *
   * Only a curated provider's asset feed earns `via: "feed"`. Everything else is
   * matched on its text like any other article.
   */
  readonly curated: boolean;
  /** Whether this provider can answer the query at all. */
  supports(query: NewsQuery): boolean;
  /**
   * Answer the given queries. Must resolve for every input query, using `error`
   * to report the ones it could not serve.
   */
  fetch(queries: NewsQuery[]): Promise<NewsFetchResult[]>;
}

/* ------------------------------------------------------------------ matching */

/**
 * How an article came to be attached to an asset. Stored alongside the match so
 * a weak association is auditable rather than anonymous — which matters most in
 * Phase D, where an insight has to be able to say what it read and why.
 *
 *   feed    a *curated* provider filed the article against that asset. Provenance,
 *           not text analysis — see `NewsProvider.curated`. A search provider
 *           asked about one asset does not qualify, however targeted the query.
 *   symbol  its ticker appears as a standalone uppercase token.
 *   name    its name appears in the headline.
 *   alias   a hand-written synonym appears ("bullion" for gold).
 */
export const MATCH_VIA = ["feed", "symbol", "name", "alias"] as const;
export type MatchVia = (typeof MATCH_VIA)[number];

export interface NewsMatch {
  assetId: string;
  score: number;
  via: MatchVia;
}
