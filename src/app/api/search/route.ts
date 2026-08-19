import { NextResponse } from "next/server";
import { searchAssets } from "@/lib/search/store";
import { toRow } from "@/lib/search/view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A search box, not a document. Anything longer is a paste, not a query. */
const MAX_QUERY = 120;
const MAX_LIMIT = 25;

/**
 * GET /api/search?q=gold&limit=8 — rank tracked assets against a phrase.
 *
 * Exists for the nav typeahead; `/search` renders the same results server-side and
 * needs no JavaScript. Read-only, and it triggers no refresh: a search must not
 * be a way to make the app go and fetch ninety quotes.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const query = (params.get("q") ?? "").slice(0, MAX_QUERY);

  if (!query.trim()) return NextResponse.json({ query: "", results: [] });

  const asked = Number(params.get("limit"));
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), MAX_LIMIT) : undefined;

  try {
    const results = await searchAssets(query, { limit });
    return NextResponse.json({ query, results: results.map(toRow) });
  } catch (e) {
    return NextResponse.json({ error: `Search failed: ${(e as Error).message}` }, { status: 500 });
  }
}
