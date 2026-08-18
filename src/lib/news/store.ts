/**
 * Where news meets the database.
 *
 * Every Prisma call for news lives here, so the parser, the matcher and the
 * providers stay pure and offline-testable. Same rule as `markets/store.ts`:
 * this writes `NewsArticle`/`NewsMatch`/`NewsRun` and reads `Asset`, never the
 * ledger.
 */
import { prisma } from "@/lib/db";
import type { AssetRef, Market } from "@/lib/markets/types";
import { listAssets } from "@/lib/markets/store";
import type { NewsArticle, NewsMatch, MatchVia } from "./types";

/* ----------------------------------------------------------------- writing */

/** One article plus everything it was matched to. */
export interface ArticleWithMatches {
  article: NewsArticle;
  matches: NewsMatch[];
}

export interface SaveSummary {
  /** Articles offered, including ones already stored. */
  seen: number;
  /** Articles that did not exist before this call. */
  created: number;
  /** Match rows written. */
  matched: number;
}

const CHUNK = 100;

/**
 * Persist articles and their matches.
 *
 * **First writer wins.** An article that already exists is left alone except for
 * fields it is missing — the same rule the market registry applies to prices,
 * and for the same reason: the second copy of a story is often the thinner one
 * (Google's redirect wrapper carries no standfirst where Yahoo's feed does), and
 * overwriting would be strictly worse data than we had. Matches are created but
 * never downgraded, so a `via: "feed"` link established when we knew the
 * provenance survives a later text-only pass that could only have guessed.
 */
export async function saveArticles(entries: ArticleWithMatches[]): Promise<SaveSummary> {
  const summary: SaveSummary = { seen: 0, created: 0, matched: 0 };
  if (entries.length === 0) return summary;

  // Collapse repeats across queries first: the same story legitimately arrives
  // from an asset feed and a market feed in one ingest, and writing it twice in
  // one transaction is the one thing SQLite will not forgive.
  const byId = new Map<string, ArticleWithMatches>();
  for (const entry of entries) {
    summary.seen++;
    const existing = byId.get(entry.article.id);
    if (!existing) {
      byId.set(entry.article.id, { article: entry.article, matches: [...entry.matches] });
      continue;
    }
    existing.article = {
      ...existing.article,
      summary: existing.article.summary ?? entry.article.summary,
      market: existing.article.market ?? entry.article.market,
    };
    for (const match of entry.matches) {
      const seen = existing.matches.find((m) => m.assetId === match.assetId);
      if (!seen) existing.matches.push(match);
      else if (match.score > seen.score) Object.assign(seen, match);
    }
  }

  const unique = [...byId.values()];
  const existingIds = new Set(
    (
      await prisma.newsArticle.findMany({
        where: { id: { in: unique.map((e) => e.article.id) } },
        select: { id: true },
      })
    ).map((r) => r.id),
  );

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    await prisma.$transaction(
      chunk.map(({ article }) =>
        prisma.newsArticle.upsert({
          where: { id: article.id },
          create: {
            id: article.id,
            title: article.title,
            url: article.url,
            source: article.source,
            provider: article.provider,
            summary: article.summary,
            publishedAt: article.publishedAt,
            market: article.market,
          },
          // Fill gaps only. `undefined` tells Prisma to leave the column alone,
          // which is what makes this a fill rather than an overwrite.
          update: {
            summary: article.summary ?? undefined,
            market: article.market ?? undefined,
          },
        }),
      ),
    );
  }
  summary.created = unique.filter((e) => !existingIds.has(e.article.id)).length;

  // Only match against assets that exist. A match is a real foreign key, and an
  // article naming a symbol we do not track would otherwise fail the whole batch.
  const known = new Set(
    (
      await prisma.asset.findMany({
        where: { id: { in: [...new Set(unique.flatMap((e) => e.matches.map((m) => m.assetId)))] } },
        select: { id: true },
      })
    ).map((r) => r.id),
  );

  const rows = unique.flatMap(({ article, matches }) =>
    matches
      .filter((m) => known.has(m.assetId))
      .map((m) => ({ articleId: article.id, assetId: m.assetId, score: m.score, via: m.via })),
  );

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await prisma.$transaction(
      chunk.map((row) =>
        prisma.newsMatch.upsert({
          where: { articleId_assetId: { articleId: row.articleId, assetId: row.assetId } },
          create: row,
          // Never downgrade an existing link — see the note above.
          update: {},
        }),
      ),
    );
  }
  summary.matched = rows.length;

  return summary;
}

/* ----------------------------------------------------------------- reading */

export interface NewsFilter {
  /**
   * Articles belonging to this market — either fetched from its feed, or matched
   * to one of its assets. Both, because a story about gold reaches the
   * commodities page down either route and the reader does not care which.
   */
  market?: Market;
  /** Articles matched to any of these assets. */
  assetIds?: string[];
  since?: Date;
  /** Articles published no later than this. Omit for "up to now". */
  until?: Date;
  limit?: number;
  /** Drop matches weaker than this from the returned rows. */
  minScore?: number;
}

/** An article as the pages want it: matches resolved to real assets. */
export interface NewsItem {
  article: NewsArticle;
  matches: (NewsMatch & { symbol: string; name: string; market: Market })[];
}

const DEFAULT_LIMIT = 40;

type MatchRow = {
  assetId: string;
  score: number;
  via: string;
  asset: { symbol: string; name: string; market: string };
};

type ArticleRow = {
  id: string;
  title: string;
  url: string;
  source: string;
  provider: string;
  summary: string | null;
  publishedAt: Date;
  market: string | null;
  matches: MatchRow[];
};

function toItem(row: ArticleRow): NewsItem {
  return {
    article: {
      id: row.id,
      title: row.title,
      url: row.url,
      source: row.source,
      provider: row.provider,
      summary: row.summary,
      publishedAt: row.publishedAt,
      market: (row.market as Market | null) ?? null,
    },
    matches: row.matches
      .map((m) => ({
        assetId: m.assetId,
        score: m.score,
        via: m.via as MatchVia,
        symbol: m.asset.symbol,
        name: m.asset.name,
        market: m.asset.market as Market,
      }))
      .sort((a, b) => b.score - a.score),
  };
}

export async function listNews(filter: NewsFilter = {}): Promise<NewsItem[]> {
  const minScore = filter.minScore ?? 0;

  const where: Record<string, unknown> = {};
  if (filter.since || filter.until) {
    where.publishedAt = {
      ...(filter.since ? { gte: filter.since } : {}),
      ...(filter.until ? { lte: filter.until } : {}),
    };
  }
  if (filter.market) {
    where.OR = [{ market: filter.market }, { matches: { some: { asset: { market: filter.market } } } }];
  }
  if (filter.assetIds?.length) {
    where.matches = { some: { assetId: { in: filter.assetIds }, score: { gte: minScore } } };
  }

  const rows = await prisma.newsArticle.findMany({
    where,
    orderBy: { publishedAt: "desc" },
    take: filter.limit ?? DEFAULT_LIMIT,
    include: {
      matches: {
        where: { score: { gte: minScore } },
        include: { asset: { select: { symbol: true, name: true, market: true } } },
      },
    },
  });

  return rows.map(toItem);
}

/** Headlines for one asset, strongest-linked first within each day. */
export async function newsForAsset(assetId: string, limit = 12): Promise<NewsItem[]> {
  return listNews({ assetIds: [assetId], limit });
}

/** Every tracked asset — what the matcher needs to run against. */
export async function matchableAssets(): Promise<AssetRef[]> {
  return listAssets();
}

/* ------------------------------------------------------------------ upkeep */

/**
 * Drop articles past their useful life.
 *
 * News is disposable in a way prices are not: a stale quote is wrong, but a
 * three-month-old headline is merely irrelevant, and keeping every one forever
 * would grow the table without ever being read. Matches cascade with it.
 */
export async function pruneNews(olderThanDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const { count } = await prisma.newsArticle.deleteMany({ where: { publishedAt: { lt: cutoff } } });
  return count;
}

export async function lastNewsRun(): Promise<{
  scope: string;
  finishedAt: Date | null;
  articlesNew: number;
  queriesFail: number;
  error: string | null;
} | null> {
  return prisma.newsRun.findFirst({
    orderBy: { startedAt: "desc" },
    select: { scope: true, finishedAt: true, articlesNew: true, queriesFail: true, error: true },
  });
}

/** The most recent article we hold, for staleness checks. */
export async function newestArticleAt(market?: Market): Promise<Date | null> {
  const row = await prisma.newsArticle.findFirst({
    where: market ? { OR: [{ market }, { matches: { some: { asset: { market } } } }] } : undefined,
    orderBy: { fetchedAt: "desc" },
    select: { fetchedAt: true },
  });
  return row?.fetchedAt ?? null;
}
