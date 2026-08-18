import { NextResponse } from "next/server";
import { AiUnavailableError, StructuredTaskError } from "@/lib/ai";
import { generateInsight } from "@/lib/insights/generate";
import { isMarket, type Market } from "@/lib/markets/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One insight is up to three model calls, and a local model can spend minutes on
 * each. Only hosting platforms enforce this; locally the request stays open.
 */
export const maxDuration = 900;

/**
 * POST /api/insights — write this week's insight for one market.
 *
 * Body: { "market": "commodities", "force": true, "week": "2026-08-17" }
 *
 * Returns the cached insight rather than regenerating unless `force` is set: the
 * answer is the same for a whole week and the call is expensive. A market with
 * nothing unusual and no headlines returns `status: "skipped"` — an honest answer,
 * and a cheaper one than asking a model about nothing.
 */
export async function POST(req: Request) {
  let body: { market?: unknown; force?: unknown; week?: unknown } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!isMarket(body.market)) {
    return NextResponse.json(
      { error: `Unknown or missing market: ${String(body.market)}` },
      { status: 400 },
    );
  }
  const market = body.market as Market;

  let weekStart: string | undefined;
  if (body.week !== undefined) {
    if (typeof body.week !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.week)) {
      return NextResponse.json({ error: "week must be yyyy-mm-dd." }, { status: 400 });
    }
    weekStart = body.week;
  }

  try {
    const outcome = await generateInsight({ market, weekStart, force: body.force === true });
    if (outcome.status === "skipped") {
      return NextResponse.json({
        status: "skipped",
        market,
        reason: outcome.reason,
        movements: outcome.pack.movements.length,
        articles: outcome.pack.articles.length,
      });
    }
    return NextResponse.json({
      status: outcome.status,
      market,
      weekStart: outcome.insight.weekStart,
      verdict: outcome.insight.status,
      model: outcome.insight.model,
      headline: outcome.insight.headline,
      attempts: outcome.status === "generated" ? outcome.attempts : 0,
      movements: outcome.insight.body.readings.length,
    });
  } catch (e) {
    // Nothing configured, or three answers that failed validation. Both are the
    // caller's problem to act on, not a server fault — and neither stored anything.
    if (e instanceof AiUnavailableError || e instanceof StructuredTaskError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    return NextResponse.json(
      { error: `Generating this insight failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
