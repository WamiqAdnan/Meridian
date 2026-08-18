import { NextResponse } from "next/server";
import { ingestNews } from "@/lib/news/ingest";
import { isMarket, type Market } from "@/lib/markets/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A full sweep is one request per market per provider, plus the movers. */
export const maxDuration = 300;

/**
 * POST /api/news/refresh — pull fresh headlines.
 *
 * Body (all optional):
 *   { "market": "commodities", "days": 7 }
 *
 * Sweeps every market by default and adds a per-asset lookup for anything whose
 * latest session was unusual by its own standards.
 */
export async function POST(req: Request) {
  let body: { market?: unknown; days?: unknown } = {};
  try {
    // An empty body is the common case (refresh everything), not an error.
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  let market: Market | undefined;
  if (body.market !== undefined && body.market !== null) {
    if (!isMarket(body.market)) {
      return NextResponse.json({ error: `Unknown market: ${String(body.market)}` }, { status: 400 });
    }
    market = body.market;
  }

  let days: number | undefined;
  if (body.days !== undefined) {
    days = Number(body.days);
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      return NextResponse.json({ error: "days must be between 1 and 90." }, { status: 400 });
    }
  }

  try {
    const outcome = await ingestNews({ market, days });
    return NextResponse.json({
      scope: outcome.scope,
      queriesRun: outcome.queriesRun,
      queriesEmpty: outcome.queriesFail,
      articlesSeen: outcome.articlesSeen,
      articlesNew: outcome.articlesNew,
      matchesMade: outcome.matchesMade,
      unusual: outcome.candidates.map((c) => ({
        assetId: c.asset.id,
        changePct: c.changePct,
        zScore: c.zScore,
      })),
      // Enough to diagnose without dumping every message into the response.
      errors: outcome.errors.slice(0, 10),
      finishedAt: outcome.finishedAt,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `News ingest failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
