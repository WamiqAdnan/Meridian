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
import type { Market } from "@/lib/markets/types";
import { latestInsight } from "./store";
import { weekStartOf, type StoredInsight } from "./types";

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
