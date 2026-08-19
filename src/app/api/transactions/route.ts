import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildManualTrade, manualTradeNo, type ManualTradeInput } from "@/lib/ledger";
import { isMarket, type Market } from "@/lib/markets/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/transactions — record one hand-entered trade.
 *
 * The counterpart to the PDF importer, and the only way a non-PSX position can
 * exist: the importer reads broker statements, and no broker here issues one for
 * bitcoin. Body:
 *
 *   { owner, assetId, side, tradeDate, qty, rate, fees?, settlementDate? }
 *
 * The asset must already exist — `POST /api/assets` creates one, and does so only
 * after a provider has proved it can price it. Requiring that here keeps the
 * ledger from accumulating positions in things nothing can ever value.
 */
export async function POST(req: Request) {
  let body: ManualTradeInput & { assetId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const assetId = typeof body.assetId === "string" ? body.assetId.trim() : "";
  if (!assetId) {
    return NextResponse.json({ error: "Pick an asset to record the trade against." }, { status: 400 });
  }

  const row = await prisma.asset.findUnique({ where: { id: assetId } });
  if (!row) {
    return NextResponse.json(
      { error: `We don't track ${assetId} yet. Add it first, then record the trade.` },
      { status: 404 },
    );
  }
  if (!isMarket(row.market)) {
    return NextResponse.json({ error: `${assetId} has an unknown market.` }, { status: 409 });
  }

  const result = buildManualTrade(body, {
    id: row.id,
    symbol: row.symbol,
    market: row.market as Market,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.errors.join(" "), errors: result.errors }, { status: 400 });
  }

  // `@@unique([broker, tradeNo])` is a dedup key for imports. A manual row's
  // number is generated, so a collision means two entries landed in the same
  // millisecond — retry with a fresh one rather than rejecting a real trade.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const created = await prisma.transaction.create({
        data: attempt === 0 ? result.trade : { ...result.trade, tradeNo: manualTradeNo() },
      });
      return NextResponse.json({ ok: true, transaction: created }, { status: 201 });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "P2002") {
        return NextResponse.json(
          { error: `Could not save the trade: ${(e as Error).message}` },
          { status: 500 },
        );
      }
    }
  }

  return NextResponse.json({ error: "Could not allocate a trade number." }, { status: 409 });
}
