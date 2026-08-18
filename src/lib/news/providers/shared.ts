/**
 * The parts every news provider repeats: fetch a feed, turn its items into
 * articles, and name the publisher.
 *
 * Kept here so no provider has to import a sibling, mirroring
 * `markets/providers/shared.ts`.
 */
import { mapWithConcurrency } from "@/lib/markets/providers/shared";
import type { Market } from "@/lib/markets/types";
import { articleIdFor, canonicalUrl, parseFeed, type RssItem } from "../rss";
import type { NewsArticle } from "../types";

export { mapWithConcurrency };

/** Polite parallelism, matching the market providers' posture. */
export const CONCURRENCY = 4;
export const TIMEOUT_MS = 15_000;

/** Most items to keep from one feed when the query does not say. */
export const DEFAULT_LIMIT = 12;

export interface FeedFetch {
  items: RssItem[];
  /** Items the parser refused — no title, no link, or no believable date. */
  skipped: number;
  error: string | null;
}

/**
 * GET one feed and parse it.
 *
 * Never throws: a dead feed is an ordinary outcome here, and the caller has other
 * providers to fall back on.
 */
export async function fetchFeed(url: string, label: string): Promise<FeedFetch> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/rss+xml, application/xml, text/xml" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      return { items: [], skipped: 0, error: `${label} responded ${res.status}` };
    }
    const { items, skipped } = parseFeed(await res.text());
    return { items, skipped, error: null };
  } catch (e) {
    return { items: [], skipped: 0, error: `Could not reach ${label}: ${(e as Error).message}` };
  }
}

/** Hostnames worth printing properly. Anything else shows as its bare domain. */
const PRETTY_HOSTS: Record<string, string> = {
  "finance.yahoo.com": "Yahoo Finance",
  "www.cnbc.com": "CNBC",
  "www.reuters.com": "Reuters",
  "www.bloomberg.com": "Bloomberg",
  "www.ft.com": "Financial Times",
  "www.wsj.com": "The Wall Street Journal",
  "www.investing.com": "Investing.com",
  "seekingalpha.com": "Seeking Alpha",
  "www.marketwatch.com": "MarketWatch",
  "www.fxstreet.com": "FXStreet",
  "www.dawn.com": "Dawn",
  "www.brecorder.com": "Business Recorder",
};

/**
 * Who published this, derived from the link.
 *
 * The fallback is the bare hostname rather than a guess at a brand name: showing
 * "benzinga.com" is honest, and inventing "Benzinga News" would not be.
 */
export function publisherFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PRETTY_HOSTS[host] ?? host.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

/** Letters and digits only, single-spaced — for comparing prose that differs only in punctuation. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Whether a feed's description is just the headline again.
 *
 * Google News fills `<description>` with the title followed by the publisher and
 * nothing else — there is no standfirst behind it. Storing that would print every
 * headline twice on screen, and would hand Phase D a "summary" that adds no
 * information while looking like it does. An empty summary is the honest record
 * of a feed that supplied none.
 */
export function isEchoOfTitle(summary: string, title: string, source: string): boolean {
  const body = normalise(summary);
  const head = normalise(title);
  if (!head || !body.startsWith(head)) return false;
  const rest = body.slice(head.length).replace(normalise(source), "").trim();
  return rest.length < 25;
}

export interface ToArticlesOptions {
  provider: string;
  market: Market | null;
  /** Publisher to use when the feed did not name one. */
  fallbackSource?: string;
  /** Drop anything published before this yyyy-mm-dd. */
  since?: string;
  limit?: number;
  /**
   * Strip a trailing " - Publisher" from the headline. True only for Google News,
   * which appends it to every title and also names the publisher properly in a
   * `<source>` element — so the suffix is redundant rather than guessed at.
   */
  stripSourceSuffix?: boolean;
}

/**
 * Normalise feed items into articles, newest first.
 *
 * Deduplicates within the batch: a feed occasionally lists the same story twice
 * under different tracking URLs, and both would otherwise become the same row
 * written twice in the same transaction.
 */
export function toArticles(items: RssItem[], options: ToArticlesOptions): NewsArticle[] {
  const seen = new Set<string>();
  const out: NewsArticle[] = [];

  for (const item of items) {
    const url = canonicalUrl(item.link);
    const id = articleIdFor(url);
    if (seen.has(id)) continue;

    if (options.since && item.publishedAt.toISOString().slice(0, 10) < options.since) continue;

    const source = item.sourceName ?? options.fallbackSource ?? publisherFromUrl(url);

    let title = item.title;
    if (options.stripSourceSuffix && item.sourceName) {
      const suffix = ` - ${item.sourceName}`;
      if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
    }
    if (!title) continue;

    const summary =
      item.description && !isEchoOfTitle(item.description, title, source)
        ? item.description
        : null;

    seen.add(id);
    out.push({
      id,
      title,
      url,
      source,
      provider: options.provider,
      summary,
      publishedAt: item.publishedAt,
      market: options.market,
    });
  }

  out.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  return out.slice(0, options.limit ?? DEFAULT_LIMIT);
}
