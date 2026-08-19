/**
 * What the pages actually show.
 *
 * Reading is deliberately separate from generating. A page render loads whatever
 * is stored and never triggers a model call — unlike prices and news, which
 * refresh themselves when stale. Generation costs minutes against a local model
 * and produces one answer per market per week; paying for it on a page view would
 * be both slow and pointless.
 *
 * So an insight arrives by `npm run insights:generate`, a scheduled run, or the
 * button on the market page. Until one does, the page says so.
 *
 * Server-side only; it reads the database.
 */
import { aiBackendLabel } from "@/lib/ai";
import { MARKETS, MARKET_META, type Market } from "@/lib/markets/types";
import { latestInsight, latestInsights } from "./store";
import { accountedFor, weekStartOf, type InsightStatus, type StoredInsight } from "./types";

export interface InsightPanel {
  /** The newest insight for this market, or null if it has never had one. */
  insight: StoredInsight | null;
  /** The week the app would generate for now. */
  weekStart: string;
  /** True when the stored insight is about an earlier week than the current one. */
  stale: boolean;
  /** Where generation would run — null when nothing is configured. */
  backend: string | null;
}

export async function loadInsightPanel(
  market: Market,
  now: Date = new Date(),
): Promise<InsightPanel> {
  const weekStart = weekStartOf(now);
  const insight = await latestInsight(market);
  return {
    insight,
    weekStart,
    stale: insight != null && insight.weekStart !== weekStart,
    backend: aiBackendLabel(),
  };
}

/* ------------------------------------------------------------------ digest */

/** One market's insight, reduced to what an overview row shows. */
export interface InsightDigestEntry {
  market: Market;
  label: string;
  weekStart: string;
  stale: boolean;
  headline: string;
  summary: string;
  status: InsightStatus;
  /** How many unusual moves the headlines accounted for, out of how many there were. */
  explained: number;
  total: number;
  articlesConsidered: number;
  generatedAt: Date;
  model: string;
}

export interface InsightDigest {
  entries: InsightDigestEntry[];
  /** The week the app would generate for now. */
  weekStart: string;
  /** Markets that have never had an insight at all. */
  missing: Market[];
  backend: string | null;
}

/**
 * Every market's newest insight, in market display order.
 *
 * One query for all eight — `latestInsights()` — which is why this is cheap enough
 * for the overview to call on every render. It is still read-only: an overview
 * that generated an insight it found missing would spend up to twenty-four model
 * calls on a page view, which is the trap `insights/view.ts` exists to avoid.
 */
export async function loadInsightDigest(now: Date = new Date()): Promise<InsightDigest> {
  const weekStart = weekStartOf(now);
  const stored = await latestInsights();
  const byMarket = new Map(stored.map((i) => [i.market, i]));

  const entries: InsightDigestEntry[] = [];
  const missing: Market[] = [];
  for (const market of MARKETS) {
    const insight = byMarket.get(market);
    if (!insight) {
      missing.push(market);
      continue;
    }
    const { explained, total } = accountedFor(insight);
    entries.push({
      market,
      label: MARKET_META[market].label,
      weekStart: insight.weekStart,
      stale: insight.weekStart !== weekStart,
      headline: insight.body.headline,
      summary: insight.body.summary,
      status: insight.status,
      explained,
      total,
      articlesConsidered: insight.body.articlesConsidered,
      generatedAt: insight.generatedAt,
      model: insight.model,
    });
  }

  return { entries, weekStart, missing, backend: aiBackendLabel() };
}
