/**
 * Which providers answer which query, and how their answers combine.
 *
 * This is where the news layer parts company with `markets/registry.ts`, and the
 * difference is the point:
 *
 *   Market data **falls back**. A price is a fact with one right answer, so the
 *   preferred provider is asked, and another is tried only when the first fails.
 *   Asking two providers for the price of gold is pure waste.
 *
 *   News **unions**. Coverage is not a fact with one right answer — two desks on
 *   the same move is the entire reason to have two desks. Every provider that
 *   supports a query is asked, and the results are merged and deduplicated by
 *   canonical URL. Fallback then comes for free: if Yahoo's feed is down, Google's
 *   answer is already in the union.
 *
 * The cost of unioning is bounded at the *query* level rather than here — see
 * `newsworthy` in `relevance.ts`, which decides how few assets are worth asking
 * about at all.
 *
 * Nothing here touches the database. `ingest.ts` decides what to persist.
 */
import { cnbcProvider } from "./providers/cnbc";
import { googleNewsProvider } from "./providers/google";
import { yahooNewsProvider } from "./providers/yahoo";
import type { NewsArticle, NewsFetchResult, NewsProvider, NewsQuery } from "./types";

/** Registration order is preference order when two providers return the same story. */
export const NEWS_PROVIDERS: NewsProvider[] = [yahooNewsProvider, googleNewsProvider, cnbcProvider];

export function newsProviderById(
  id: string,
  registry: NewsProvider[] = NEWS_PROVIDERS,
): NewsProvider | undefined {
  return registry.find((p) => p.id === id);
}

/**
 * The providers whose asset feeds count as provenance.
 *
 * Passed to the matcher so `via: "feed"` is granted on the strength of *who
 * answered*, not merely on the query having named an asset.
 */
export function curatedProviderIds(registry: NewsProvider[] = NEWS_PROVIDERS): Set<string> {
  return new Set(registry.filter((p) => p.curated).map((p) => p.id));
}

/** Every registered provider that can answer this query, in preference order. */
export function candidateProviders(
  query: NewsQuery,
  registry: NewsProvider[] = NEWS_PROVIDERS,
): NewsProvider[] {
  return registry.filter((p) => p.supports(query));
}

/** What the union produced for one query. */
export interface NewsQueryOutcome {
  query: NewsQuery;
  /** Deduplicated across providers, newest first. */
  articles: NewsArticle[];
  /** Providers that returned at least one article. */
  providersOk: string[];
  /** Every failure reported for this query, from any provider. */
  errors: string[];
}

function byNewest(a: NewsArticle, b: NewsArticle): number {
  return b.publishedAt.getTime() - a.publishedAt.getTime();
}

/**
 * Collapse the same story arriving from several providers into one article.
 *
 * The first copy wins on identity, but a later copy may fill a field the first
 * left empty. The rule is the market registry's, applied to prose: never let a
 * second, thinner answer overwrite something already known. Yahoo's feed carries
 * a standfirst where Google's redirect wrapper often does not, and losing it
 * because the same story arrived twice would be strictly worse data than we had.
 */
export function mergeArticles(articles: NewsArticle[]): NewsArticle[] {
  const byId = new Map<string, NewsArticle>();
  for (const article of articles) {
    const existing = byId.get(article.id);
    if (!existing) {
      byId.set(article.id, article);
      continue;
    }
    byId.set(article.id, {
      ...existing,
      summary: existing.summary ?? article.summary,
      market: existing.market ?? article.market,
      source: existing.source || article.source,
    });
  }
  return [...byId.values()].sort(byNewest);
}

/**
 * Ask every supporting provider, and merge what comes back.
 *
 * Resolves with exactly one outcome per input query, in input order. A provider
 * that throws outright is contained to itself — one broken feed never takes the
 * ingest down with it.
 */
export async function fetchNews(
  queries: NewsQuery[],
  /** Overridable so the check script can exercise routing and merging offline. */
  registry: NewsProvider[] = NEWS_PROVIDERS,
): Promise<NewsQueryOutcome[]> {
  const outcomes: NewsQueryOutcome[] = queries.map((query) => ({
    query,
    articles: [],
    providersOk: [],
    errors: [],
  }));
  if (queries.length === 0) return outcomes;

  await Promise.all(
    registry.map(async (provider) => {
      const picked: { index: number; query: NewsQuery }[] = [];
      queries.forEach((query, index) => {
        if (provider.supports(query)) picked.push({ index, query });
      });
      if (picked.length === 0) return;

      let results: NewsFetchResult[];
      try {
        results = await provider.fetch(picked.map((p) => p.query));
      } catch (e) {
        // A provider that throws rather than reporting per-query errors is a bug
        // in that provider; contain it here instead of losing the ingest.
        for (const p of picked) {
          outcomes[p.index].errors.push(`${provider.label} failed outright: ${(e as Error).message}`);
        }
        return;
      }

      picked.forEach((p, position) => {
        const result = results[position];
        const outcome = outcomes[p.index];
        if (!result) {
          outcome.errors.push(`${provider.label} returned no result for this query.`);
          return;
        }
        if (result.error) outcome.errors.push(result.error);
        if (result.articles.length > 0) {
          outcome.providersOk.push(provider.id);
          outcome.articles.push(...result.articles);
        }
      });
    }),
  );

  for (const outcome of outcomes) {
    outcome.articles = mergeArticles(outcome.articles);
  }
  return outcomes;
}
