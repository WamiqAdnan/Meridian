import { NextResponse } from "next/server";
import { refreshMarketData } from "@/lib/markets/refresh";
import { isMarket, type Market } from "@/lib/markets/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A full backfill fetches one payload per asset; a quote refresh is much faster. */
export const maxDuration = 300;

/**
 * POST /api/markets/refresh — fetch fresh market data.
 *
 * Body (all optional):
 *   { "market": "crypto", "history": true, "range": "1y" }
 *
 * Quote-only by default. `history` also pulls daily bars, which is the slow path
 * and normally belongs in the scheduled job rather than a button.
 */
const RANGES = new Set(["1mo", "3mo", "6mo", "1y"]);

export async function POST(req: Request) {
  let body: { market?: unknown; history?: unknown; range?: unknown } = {};
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

  const range = typeof body.range === "string" ? body.range : "1y";
  if (body.history === true && !RANGES.has(range)) {
    return NextResponse.json({ error: `Unknown range: ${range}` }, { status: 400 });
  }

  try {
    const outcome = await refreshMarketData({
      market,
      range: body.history === true ? (range as "1mo" | "3mo" | "6mo" | "1y") : undefined,
    });
    return NextResponse.json({
      mode: outcome.mode,
      assetsRequested: outcome.assetsRequested,
      quotesWritten: outcome.quotesWritten,
      barsWritten: outcome.barsWritten,
      failed: outcome.failures.length,
      // Enough to diagnose without dumping every message into the response.
      failures: outcome.failures.slice(0, 10),
      finishedAt: outcome.finishedAt,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `Market refresh failed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
