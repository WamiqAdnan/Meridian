import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { adoptAsset } from "@/lib/markets/adopt";
import { fetchAssets } from "@/lib/markets/registry";
import { saveResults } from "@/lib/markets/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One upstream round-trip, but a cold provider can be slow. */
export const maxDuration = 60;

/**
 * POST /api/assets — start tracking an instrument.
 *
 * Body: `{ market, symbol, name?, kind?, currency?, source?, sourceSymbol? }`
 *
 * The catalogue's standing rule is that every `sourceSymbol` was verified against
 * its provider before being written down. This route holds a user-added asset to
 * the same standard: `adoptAsset` checks every column against the vocabulary the
 * app actually knows, and then a quote is fetched and the row is only written if
 * one comes back. A typo'd ticker fails here rather than becoming a permanently
 * unpriceable position in the ledger.
 *
 * Idempotent — asking for an asset that already exists returns it.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const described = adoptAsset(body);
  if (!described.ok) {
    return NextResponse.json({ error: described.error }, { status: 400 });
  }
  const ref = described.ref;

  const existing = await prisma.asset.findUnique({ where: { id: ref.id } });
  if (existing) {
    // Re-activate rather than refuse: switching an asset back on is the same
    // action from the user's side as adding it.
    if (!existing.active) await prisma.asset.update({ where: { id: ref.id }, data: { active: true } });
    return NextResponse.json({ ok: true, asset: existing, created: false });
  }

  let priced;
  try {
    [priced] = await fetchAssets([ref], "none");
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach a price provider: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  if (!priced?.quote) {
    return NextResponse.json(
      {
        error:
          priced?.error ??
          `No provider could price ${ref.symbol} in ${ref.market}. Check the ticker, or name the provider symbol explicitly.`,
      },
      { status: 422 },
    );
  }

  const asset = await prisma.asset.create({ data: { ...ref, active: true } });
  // Keep the verifying quote instead of throwing it away — the position this
  // asset was added for should be priced the moment it is entered.
  await saveResults([priced]);

  return NextResponse.json({ ok: true, asset, created: true, price: priced.quote.price }, { status: 201 });
}
