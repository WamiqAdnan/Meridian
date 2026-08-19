/**
 * CNBC's desk feeds — market-wide coverage, no search.
 *
 * CNBC publishes a fixed RSS feed per desk and offers no query endpoint, so this
 * provider answers "what happened in this market" and declines everything else.
 * That is a genuine division of labour rather than a limitation: Google News is
 * broad but ranks by relevance to a phrase, while a desk feed is simply
 * everything that desk filed, which is the better read on a whole market.
 *
 * Every id below was fetched and its channel title confirmed before being written
 * down — the same rule `markets/catalogue.ts` follows for provider symbols.
 *
 * PSX is absent on purpose: CNBC does not cover the Pakistan Stock Exchange, and
 * a feed that never mentions it would be worse than no feed at all. `supports`
 * returns false and the registry routes that market to Google alone.
 */
import type { Market } from "@/lib/markets/types";
import type { NewsFetchResult, NewsProvider, NewsQuery } from "../types";
import { fetchFeed, toArticles, type FeedFetch } from "./shared";

/** Verified 2026-08-18: each id resolves to the channel named beside it. */
const FEEDS = {
  topNews: { id: "100003114", label: "US Top News and Analysis" },
  investing: { id: "15839069", label: "Investing" },
  economy: { id: "20910258", label: "Economy" },
  finance: { id: "10000664", label: "Finance" },
  energy: { id: "19836768", label: "Energy" },
  tech: { id: "19854910", label: "Tech" },
  business: { id: "10001147", label: "Business News" },
} as const;

type FeedKey = keyof typeof FEEDS;

/** Which desks speak to which market. */
const MARKET_FEEDS: Record<Market, FeedKey[]> = {
  stocks: ["investing", "business"],
  indices: ["topNews", "investing"],
  crypto: ["investing", "tech"],
  commodities: ["energy"],
  forex: ["economy"],
  bonds: ["economy", "finance"],
  real_estate: ["business"],
  psx: [],
};

export function cnbcFeedUrl(id: string): string {
  return `https://www.cnbc.com/id/${id}/device/rss/rss.html`;
}

/** The desks that cover this query, or an empty list if none do. */
export function feedsFor(query: NewsQuery): FeedKey[] {
  if (query.kind !== "market" || !query.market) return [];
  return MARKET_FEEDS[query.market] ?? [];
}

export const cnbcProvider: NewsProvider = {
  id: "cnbc",
  label: "CNBC",
  // Desk feeds are market-wide; nothing here is filed against an instrument.
  curated: false,

  supports(query) {
    return feedsFor(query).length > 0;
  },

  async fetch(queries) {
    // Desks are shared between markets — bonds and forex both read Economy — so
    // one ingest would otherwise fetch the same feed several times. Memoised per
    // call rather than globally: a long-lived cache would quietly serve yesterday's
    // headlines, which is the exact failure this whole layer exists to avoid.
    const inFlight = new Map<string, Promise<FeedFetch>>();
    const readFeed = (key: FeedKey): Promise<FeedFetch> => {
      const feed = FEEDS[key];
      let pending = inFlight.get(feed.id);
      if (!pending) {
        pending = fetchFeed(cnbcFeedUrl(feed.id), `CNBC ${feed.label}`);
        inFlight.set(feed.id, pending);
      }
      return pending;
    };

    return Promise.all(
      queries.map(async (query): Promise<NewsFetchResult> => {
        const keys = feedsFor(query);
        if (keys.length === 0) {
          return { query, articles: [], error: "CNBC has no desk covering this query." };
        }

        const results = await Promise.all(keys.map(readFeed));
        const items = results.flatMap((r) => r.items);
        const errors = results.map((r) => r.error).filter((e): e is string => e !== null);

        return {
          query,
          articles: toArticles(items, {
            provider: "cnbc",
            market: query.market ?? null,
            fallbackSource: "CNBC",
            since: query.since,
            limit: query.limit,
          }),
          // Every desk failing is a failure; one of two is a partial answer worth
          // reporting but not worth discarding the other desk over.
          error: errors.length === results.length ? errors.join(" | ") : null,
        };
      }),
    );
  },
};
