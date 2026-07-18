import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { refreshPrices } from "@/lib/psx-prices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  // Only refresh prices for symbols we actually hold.
  const rows = await prisma.transaction.findMany({ select: { security: true }, distinct: ["security"] });
  const symbols = rows.map((r) => r.security);

  try {
    const { updated, fetchedAt } = await refreshPrices(symbols);
    return NextResponse.json({ updated, fetchedAt });
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach the PSX price feed: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
