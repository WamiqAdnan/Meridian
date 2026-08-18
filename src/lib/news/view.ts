/**
 * What the news pages actually render.
 *
 * The thin counterpart to `markets/view.ts`: the store already returns articles
 * with their matches resolved, so all that is left is the grouping a reader
 * wants — by day, newest first — and a label for each group.
 *
 * Server-side only; it reads the database.
 */
import type { Market } from "@/lib/markets/types";
import { listNews, type NewsItem } from "./store";

/** How far back a page looks. Beyond a fortnight, "news" is really history. */
const DEFAULT_DAYS = 14;

export interface NewsDay {
  /** yyyy-mm-dd, so it sorts as text. */
  date: string;
  /** "Today", "Yesterday", or a written date. */
  label: string;
  items: NewsItem[];
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function labelFor(date: string, today: string): string {
  if (date === today) return "Today";
  const yesterday = new Date(`${today}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (date === dayKey(yesterday)) return "Yesterday";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-PK", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/**
 * Group articles into days, newest day first and newest article first within it.
 *
 * Grouping on the *published* date, not the fetched date: a story is news on the
 * day it was written, however long it took to reach us.
 */
export function groupByDay(items: NewsItem[], now: Date = new Date()): NewsDay[] {
  const today = dayKey(now);
  const byDate = new Map<string, NewsItem[]>();
  for (const item of items) {
    const key = dayKey(item.article.publishedAt);
    const bucket = byDate.get(key);
    if (bucket) bucket.push(item);
    else byDate.set(key, [item]);
  }

  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, dayItems]) => ({
      date,
      label: labelFor(date, today),
      items: dayItems.sort(
        (a, b) => b.article.publishedAt.getTime() - a.article.publishedAt.getTime(),
      ),
    }));
}

export interface NewsFeedOptions {
  market?: Market;
  assetIds?: string[];
  limit?: number;
  days?: number;
  /**
   * End of the window. Defaults to now, and `days` is counted back from it — so
   * asking for a past week returns that week's headlines rather than this one's.
   */
  until?: Date;
}

/** The headlines a page should show, already filtered and ordered. */
export async function loadNewsFeed(options: NewsFeedOptions = {}): Promise<NewsItem[]> {
  const days = options.days ?? DEFAULT_DAYS;
  const anchor = options.until?.getTime() ?? Date.now();
  return listNews({
    market: options.market,
    assetIds: options.assetIds,
    since: new Date(anchor - days * 86_400_000),
    until: options.until,
    limit: options.limit,
  });
}

/** When we last pulled any of these in — the honest "updated" stamp for a page. */
export function newestFetch(items: NewsItem[]): Date | null {
  let newest: Date | null = null;
  for (const item of items) {
    const at = item.article.publishedAt;
    if (!newest || at > newest) newest = at;
  }
  return newest;
}
