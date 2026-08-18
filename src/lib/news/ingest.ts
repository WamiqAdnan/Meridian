/**
 * The ingest job: decide what to ask about, fetch it, match it, record what
 * happened.
 *
 * The interesting decision is the first one. Fetching news for all 109 tracked
 * assets every run would be both slow and pointless — most of them did nothing —
 * so the work list is built in two parts:
 *
 *   market sweep   one query per market. Cheap, fixed size, and it is what
 *                  covers a move nobody can attribute to a single instrument.
 *   asset lookups  only for assets whose latest session was unusual *by their own
 *                  standards* — `newsworthy` in `relevance.ts`, scored in units of
 *                  the asset's own volatility rather than a fixed percentage.
 *
 * That second rule is the whole reason `unusualMove` exists. A fixed threshold
 * would spend every lookup on whatever is structurally most volatile (crypto,
 * always) and never notice the day a Treasury yield did something remarkable.
 *
 * Every run writes a `NewsRun` row, for the same reason every market refresh
 * writes a `RefreshRun`: a feed that quietly starts 404ing is indistinguishable
 * from a quiet news day unless somebody is counting.
 */
import { prisma } from "@/lib/db";
import { daysAgo, listAssets, loadBars } from "@/lib/markets/store";
import { MARKETS, type AssetRef, type Market } from "@/lib/markets/types";
import { curatedProviderIds, fetchNews, type NewsQueryOutcome } from "./registry";
import { matchArticle, newsworthy, type NewsCandidate } from "./relevance";
import { saveArticles, type ArticleWithMatches } from "./store";
import { assetQuery, marketQuery, queryKey, type NewsProvider, type NewsQuery } from "./types";

/** How stale the newest article may be before `ingestIfStale` refetches. */
export const NEWS_TTL_MS = 30 * 60_000;

/** Days of headlines to ask for. A week is the window Phase D reasons over. */
const DEFAULT_DAYS = 7;

/**
 * Enough history for `unusualMove` to have an opinion. It wants 60 sessions of
 * lookback and refuses under 20, so a 200-day window leaves room for holidays and
 * for a market that trades four days a week.
 */
const BARS_WINDOW_DAYS = 200;

export interface IngestOptions {
  /** Restrict to one market. Omit to sweep every market. */
  market?: Market;
  /** Look these assets up whether or not they moved. */
  assetIds?: string[];
  /** Days of headlines to request. */
  days?: number;
  /** Most unusual-move assets to spend a lookup on. */
  assetLimit?: number;
  /** Standard deviations from an asset's own norm before it earns a lookup. */
  minZ?: number;
  /** Skip the per-market sweep — asset lookups only. */
  skipMarkets?: boolean;
  /** Overridable so the check script can drive the whole job offline. */
  registry?: NewsProvider[];
}

export interface IngestOutcome {
  scope: string;
  queriesRun: number;
  queriesFail: number;
  articlesSeen: number;
  articlesNew: number;
  matchesMade: number;
  /** The assets whose move earned a lookup, and by how much. */
  candidates: NewsCandidate[];
  errors: string[];
  startedAt: Date;
  finishedAt: Date;
}

/**
 * Assets whose latest session was far enough from their own habits to want an
 * explanation.
 */
export async function newsworthyAssets(
  options: { market?: Market; minZ?: number; limit?: number } = {},
): Promise<NewsCandidate[]> {
  const assets = await listAssets({ market: options.market });
  if (assets.length === 0) return [];
  const bars = await loadBars(
    assets.map((a) => a.id),
    daysAgo(BARS_WINDOW_DAYS),
  );
  return newsworthy(
    assets.map((asset) => ({ asset, bars: bars.get(asset.id) ?? [] })),
    { minZ: options.minZ, limit: options.limit },
  );
}

/** Turn an ingest request into a deduplicated list of provider queries. */
export function buildQueries(
  markets: Market[],
  assets: AssetRef[],
  options: { since: string; limit?: number } ,
): NewsQuery[] {
  const byKey = new Map<string, NewsQuery>();
  const add = (query: NewsQuery) => {
    const key = queryKey(query);
    if (!byKey.has(key)) byKey.set(key, query);
  };
  for (const market of markets) add(marketQuery(market, { since: options.since, limit: options.limit }));
  for (const asset of assets) add(assetQuery(asset, { since: options.since, limit: options.limit }));
  return [...byKey.values()];
}

/**
 * Attach every article an outcome returned to the assets it concerns.
 *
 * Provenance is decided per *article*, not per query, because one outcome is the
 * union of several providers' answers to the same question. An article earns
 * `via: "feed"` only when a curated provider filed it against that asset — Yahoo
 * does; Google, asked the same question, runs a text search and will happily
 * return a crypto-converter listing for "UAE Dirham". Everything from a
 * non-curated provider is matched on its text like any other article, which is
 * both honest and, in practice, what keeps that junk out.
 */
export function matchOutcomes(
  outcomes: NewsQueryOutcome[],
  assets: AssetRef[],
  curated: Set<string>,
): ArticleWithMatches[] {
  const entries: ArticleWithMatches[] = [];
  for (const outcome of outcomes) {
    const queryAssetId = outcome.query.kind === "asset" ? outcome.query.asset?.id : undefined;
    for (const article of outcome.articles) {
      const feedAssetId = curated.has(article.provider) ? queryAssetId : undefined;
      entries.push({ article, matches: matchArticle(article, assets, { feedAssetId }) });
    }
  }
  return entries;
}

export async function ingestNews(options: IngestOptions = {}): Promise<IngestOutcome> {
  const startedAt = new Date();
  const scope = options.market ?? "all";
  const since = daysAgo(options.days ?? DEFAULT_DAYS);

  const run = await prisma.newsRun.create({ data: { scope } });

  try {
    const candidates = await newsworthyAssets({
      market: options.market,
      minZ: options.minZ,
      limit: options.assetLimit,
    });

    const forced = options.assetIds?.length
      ? await listAssets({ ids: options.assetIds })
      : [];
    // Explicitly requested assets come first, so a caller asking about one
    // instrument is never crowded out by the movers list.
    const lookups = [...forced, ...candidates.map((c) => c.asset)];

    const markets = options.skipMarkets ? [] : options.market ? [options.market] : [...MARKETS];
    const queries = buildQueries(markets, lookups, { since });

    const outcomes = await fetchNews(queries, options.registry);
    const assets = await listAssets();
    const entries = matchOutcomes(outcomes, assets, curatedProviderIds(options.registry));
    const summary = await saveArticles(entries);

    const errors = outcomes.flatMap((o) => o.errors);
    const queriesFail = outcomes.filter((o) => o.articles.length === 0).length;
    const finishedAt = new Date();

    await prisma.newsRun.update({
      where: { id: run.id },
      data: {
        finishedAt,
        queriesRun: queries.length,
        queriesFail,
        articlesSeen: summary.seen,
        articlesNew: summary.created,
        matchesMade: summary.matched,
        // A sample, not a log — the point is to notice, not to archive.
        error: errors.length > 0 ? errors.slice(0, 5).join(" | ") : null,
      },
    });

    return {
      scope,
      queriesRun: queries.length,
      queriesFail,
      articlesSeen: summary.seen,
      articlesNew: summary.created,
      matchesMade: summary.matched,
      candidates,
      errors,
      startedAt,
      finishedAt,
    };
  } catch (e) {
    await prisma.newsRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), error: (e as Error).message },
    });
    throw e;
  }
}

/**
 * Ingest only if the newest article is older than `maxAgeMs`.
 *
 * Swallows failures on purpose — this runs on page render, and a page showing
 * yesterday's headlines beats one that 500s because a feed blinked. Same contract
 * as `refreshIfStale`.
 */
export async function ingestIfStale(
  options: IngestOptions & { maxAgeMs?: number } = {},
): Promise<void> {
  const maxAge = options.maxAgeMs ?? NEWS_TTL_MS;
  try {
    const newest = await prisma.newsRun.findFirst({
      where: { finishedAt: { not: null }, ...(options.market ? { scope: options.market } : {}) },
      orderBy: { startedAt: "desc" },
      select: { finishedAt: true },
    });
    // Judged on when we last *asked*, not on the newest headline: a genuinely
    // quiet market would otherwise be re-swept on every single page render.
    if (newest?.finishedAt && Date.now() - newest.finishedAt.getTime() < maxAge) return;
    await ingestNews(options);
  } catch {
    // Offline, or a feed is down. Whatever is stored still renders.
  }
}
