/**
 * Google News search — the provider that can be asked about anything.
 *
 * `GET /rss/search?q={phrase}` turns any phrase into a feed, which makes it the
 * only source here that covers a Pakistani equity, a currency pair and a macro
 * topic with the same request. Keyless, and it names the publisher properly in a
 * `<source url>` element rather than leaving it to be guessed from the link.
 *
 * Two quirks it is worth knowing about:
 *
 *   - Every headline gets " - Publisher" appended. Because `<source>` states the
 *     publisher separately, the suffix can be removed by exact match rather than
 *     by guessing where a title ends — see `stripSourceSuffix`.
 *   - Links are `news.google.com/rss/articles/…` redirects, not publisher URLs.
 *     They are stable per article, so they still work as an identity; they just
 *     cannot be deduplicated against the same story arriving from Yahoo.
 *
 * The phrase itself is not decided here. `terms.ts` owns what to call a thing, so
 * the matcher recognises what this provider went looking for.
 */
import type { Market } from "@/lib/markets/types";
import { assetTerms, marketTerms } from "../terms";
import type { NewsFetchResult, NewsProvider, NewsQuery } from "../types";
import { CONCURRENCY, fetchFeed, mapWithConcurrency, toArticles } from "./shared";

const BASE = "https://news.google.com/rss/search";

/** Days of history the `when:` operator should ask for, given a `since` date. */
function whenDays(since: string | undefined, now: Date): number | null {
  if (!since) return null;
  const start = new Date(`${since}T00:00:00Z`).getTime();
  if (!Number.isFinite(start)) return null;
  const days = Math.ceil((now.getTime() - start) / 86_400_000);
  // Google rejects `when:0d`, and beyond a year the operator stops helping.
  return Math.min(365, Math.max(1, days));
}

/** The search phrase for a query — the whole of this provider's vocabulary. */
export function searchPhrase(query: NewsQuery, now: Date = new Date()): string | null {
  let phrase: string | null = null;
  if (query.kind === "asset" && query.asset) phrase = assetTerms(query.asset).query;
  else if (query.kind === "market" && query.market) phrase = marketTerms(query.market).query;
  else if (query.kind === "topic" && query.topic) phrase = query.topic.trim() || null;
  if (!phrase) return null;

  const days = whenDays(query.since, now);
  return days ? `${phrase} when:${days}d` : phrase;
}

export function googleNewsUrl(phrase: string): string {
  return `${BASE}?q=${encodeURIComponent(phrase)}&hl=en-US&gl=US&ceid=US:en`;
}

export const googleNewsProvider: NewsProvider = {
  id: "google",
  label: "Google News",
  // A relevance search, not an editorial filing. Its results are matched on text.
  curated: false,

  supports(query) {
    return searchPhrase(query) !== null;
  },

  async fetch(queries) {
    return mapWithConcurrency(queries, CONCURRENCY, async (query): Promise<NewsFetchResult> => {
      const phrase = searchPhrase(query);
      if (!phrase) {
        return { query, articles: [], error: "Nothing to search for in this query." };
      }
      const feed = await fetchFeed(googleNewsUrl(phrase), `Google News (${phrase})`);
      const market: Market | null = query.asset?.market ?? query.market ?? null;
      return {
        query,
        articles: toArticles(feed.items, {
          provider: "google",
          market,
          since: query.since,
          limit: query.limit,
          stripSourceSuffix: true,
        }),
        error: feed.error,
      };
    });
  },
};
