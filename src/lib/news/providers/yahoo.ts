/**
 * Yahoo Finance per-symbol headlines.
 *
 * `GET /rss/2.0/headline?s={symbol}` returns the stories Yahoo has filed against
 * one instrument. That filing is the value: an article from this feed is about
 * that asset because the publisher says so, which is a different and much
 * stronger claim than finding the ticker in a sentence. `relevance.ts` records it
 * as `via: "feed"` for exactly that reason.
 *
 * The symbol vocabulary is Yahoo's, and it is already solved — `yahooSymbolFor`
 * in the market provider maps an asset to the name Yahoo knows it by, including
 * the assets that prefer a different price provider. Reusing it is what keeps
 * "what Yahoo calls gold" defined in one place.
 *
 * Verified coverage: equities, ETFs, crypto (BTC-USD), futures (GC=F), indices
 * (^GSPC) and bond ETFs all return headlines. **FX pairs do not** — `PKR=X`
 * answers 200 with an empty channel — so they are declined here and left to
 * Google News, which does cover them.
 */
import { yahooSymbolFor } from "@/lib/markets/providers/yahoo";
import type { NewsFetchResult, NewsProvider, NewsQuery } from "../types";
import { CONCURRENCY, fetchFeed, mapWithConcurrency, toArticles } from "./shared";

const BASE = "https://feeds.finance.yahoo.com/rss/2.0/headline";

export function yahooNewsUrl(symbol: string): string {
  return `${BASE}?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
}

/** The Yahoo symbol whose news feed covers this query, or null. */
export function newsSymbolFor(query: NewsQuery): string | null {
  if (query.kind !== "asset" || !query.asset) return null;
  if (query.asset.kind === "fx_pair") return null;
  return yahooSymbolFor(query.asset);
}

export const yahooNewsProvider: NewsProvider = {
  id: "yahoo",
  label: "Yahoo Finance",
  // Yahoo files stories against the symbols they concern — see NewsProvider.curated.
  curated: true,

  supports(query) {
    return newsSymbolFor(query) !== null;
  },

  async fetch(queries) {
    return mapWithConcurrency(queries, CONCURRENCY, async (query): Promise<NewsFetchResult> => {
      const symbol = newsSymbolFor(query);
      if (!symbol) {
        return { query, articles: [], error: "Yahoo has no news feed for this query." };
      }
      const feed = await fetchFeed(yahooNewsUrl(symbol), `Yahoo news (${symbol})`);
      return {
        query,
        articles: toArticles(feed.items, {
          provider: "yahoo",
          market: query.asset?.market ?? null,
          fallbackSource: "Yahoo Finance",
          since: query.since,
          limit: query.limit,
        }),
        error: feed.error,
      };
    });
  },
};
