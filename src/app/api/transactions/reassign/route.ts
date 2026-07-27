import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isInvestor } from "@/lib/investors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reassign many trades to one investor at once. Body: { ids: number[], owner: Investor }. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const { ids, owner } = (body ?? {}) as { ids?: unknown; owner?: unknown };

  if (!isInvestor(owner)) {
    return NextResponse.json({ error: "Invalid owner." }, { status: 400 });
  }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(n))) {
    return NextResponse.json({ error: "Expected a non-empty array of trade ids." }, { status: 400 });
  }

  const result = await prisma.transaction.updateMany({
    where: { id: { in: ids as number[] } },
    data: { owner },
  });

  return NextResponse.json({ ok: true, count: result.count, owner });
}
