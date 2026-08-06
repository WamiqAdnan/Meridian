import { NextResponse } from "next/server";
import { fetchIndexConstituents, getIndexConstituents, isIndexCode } from "@/lib/psx-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/index?code=KSE30 — an index's constituents with live prices and weights.
 * Add &fresh=1 to bypass the short server-side cache.
 *
 * The code is checked against the known list before it reaches the upstream URL, so
 * a caller can't steer the fetch anywhere else.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (!isIndexCode(code)) {
    return NextResponse.json({ error: `Unknown index code: ${code ?? "(none)"}` }, { status: 400 });
  }

  try {
    const snapshot =
      params.get("fresh") === "1"
        ? await fetchIndexConstituents(code)
        : await getIndexConstituents(code);
    return NextResponse.json(snapshot);
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach the PSX index feed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
