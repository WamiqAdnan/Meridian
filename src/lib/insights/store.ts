/**
 * Where insights meet the database.
 *
 * Every Prisma call for insights lives here, so the pack builder, the prompt and
 * the validator stay pure and offline-testable — the same rule `markets/store.ts`
 * and `news/store.ts` follow.
 *
 * One row per (market, week). Generation is expensive enough — minutes against a
 * local model — that a page render must never trigger one, so a page reads this
 * and displays whatever is here, including nothing.
 */
import { prisma } from "@/lib/db";
import type { Market } from "@/lib/markets/types";
import type { InsightBody, InsightStatus, StoredInsight } from "./types";

type Row = {
  market: string;
  weekStart: string;
  generatedAt: Date;
  model: string;
  status: string;
  headline: string;
  body: string;
};

/**
 * Bring a stored body back to life.
 *
 * JSON has no dates, so the citation timestamps come back as strings; everything
 * downstream expects `Date`, the same as a freshly built one. A body that will not
 * parse is treated as absent rather than thrown — a broken cached insight should
 * cost a regeneration, not a 500 on the market page.
 */
function parseBody(json: string): InsightBody | null {
  try {
    const body = JSON.parse(json) as InsightBody;
    for (const reading of body.readings ?? []) {
      for (const source of reading.sources ?? []) {
        source.publishedAt = new Date(source.publishedAt);
      }
    }
    return body;
  } catch {
    return null;
  }
}

function toStored(row: Row): StoredInsight | null {
  const body = parseBody(row.body);
  if (!body) return null;
  return {
    market: row.market as Market,
    weekStart: row.weekStart,
    generatedAt: row.generatedAt,
    model: row.model,
    status: row.status as InsightStatus,
    headline: row.headline,
    body,
  };
}

export async function saveInsight(insight: StoredInsight): Promise<void> {
  const data = {
    generatedAt: insight.generatedAt,
    model: insight.model,
    status: insight.status,
    headline: insight.headline,
    body: JSON.stringify(insight.body),
  };
  await prisma.marketInsight.upsert({
    where: { market_weekStart: { market: insight.market, weekStart: insight.weekStart } },
    create: { market: insight.market, weekStart: insight.weekStart, ...data },
    // Regenerating a week replaces it outright. Unlike a price or a headline,
    // there is no partial insight worth preserving — the newer one read more news.
    update: data,
  });
}

export async function loadInsight(market: Market, weekStart: string): Promise<StoredInsight | null> {
  const row = await prisma.marketInsight.findUnique({
    where: { market_weekStart: { market, weekStart } },
  });
  return row ? toStored(row) : null;
}

/** The newest insight for a market, whatever week it is from. */
export async function latestInsight(market: Market): Promise<StoredInsight | null> {
  const row = await prisma.marketInsight.findFirst({
    where: { market },
    orderBy: { weekStart: "desc" },
  });
  return row ? toStored(row) : null;
}

/**
 * The newest insight for every market that has one.
 *
 * One query rather than eight — this is what an overview page wants, and it is
 * cheap enough to call on every render.
 */
export async function latestInsights(): Promise<StoredInsight[]> {
  const rows = await prisma.marketInsight.findMany({ orderBy: [{ weekStart: "desc" }] });
  const newest = new Map<string, Row>();
  for (const row of rows) if (!newest.has(row.market)) newest.set(row.market, row);
  return [...newest.values()].map(toStored).filter((i): i is StoredInsight => i !== null);
}

/**
 * Drop insights older than `keepWeeks` weeks.
 *
 * Unbounded growth here is slower than news — one row per market per week — but an
 * insight whose sources were pruned months ago is history, not intelligence.
 */
export async function pruneInsights(keepWeeks = 26): Promise<number> {
  const cutoff = new Date(Date.now() - keepWeeks * 7 * 86_400_000).toISOString().slice(0, 10);
  const { count } = await prisma.marketInsight.deleteMany({ where: { weekStart: { lt: cutoff } } });
  return count;
}
