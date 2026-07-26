import { NextResponse } from "next/server";
import { parseFinqalabPdf } from "@/lib/finqalab-parser";
import { prisma } from "@/lib/db";
import { INVESTORS, isInvestor } from "@/lib/investors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let file: File | null = null;
  let owner: string = INVESTORS[0];
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f && typeof f !== "string") file = f;
    const o = form.get("owner");
    if (isInvestor(o)) owner = o;
  } catch {
    return NextResponse.json({ error: "Expected multipart form data with a 'file' field." }, { status: 400 });
  }
  if (!file) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }

  let parsed;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    parsed = await parseFinqalabPdf(buffer);
  } catch (e) {
    return NextResponse.json(
      { error: `Could not read the PDF: ${(e as Error).message}` },
      { status: 422 },
    );
  }

  if (parsed.trades.length === 0) {
    return NextResponse.json(
      { error: "No Finqalab trades found in this file. Is it a Periodic Trade Details Report?" },
      { status: 422 },
    );
  }

  const tradeNos = parsed.trades.map((t) => t.tradeNo);
  const existing = await prisma.transaction.findMany({
    where: { tradeNo: { in: tradeNos } },
    select: { tradeNo: true },
  });
  const existingSet = new Set(existing.map((e) => e.tradeNo));
  const fresh = parsed.trades.filter((t) => !existingSet.has(t.tradeNo));

  if (fresh.length > 0) {
    await prisma.transaction.createMany({
      data: fresh.map((t) => ({
        owner,
        security: t.security,
        tradeNo: t.tradeNo,
        tradeDate: t.tradeDate,
        settlementDate: t.settlementDate,
        side: t.side,
        rate: t.rate,
        qty: t.qty,
        grossAmount: t.grossAmount,
        brokerage: t.brokerage,
        cvt: t.cvt,
        netAmount: t.netAmount,
        sourceFile: file.name,
      })),
    });
  }

  await prisma.importBatch.create({
    data: {
      owner,
      filename: file.name,
      totalParsed: parsed.trades.length,
      tradesAdded: fresh.length,
      duplicatesSkipped: parsed.trades.length - fresh.length,
    },
  });

  return NextResponse.json({
    filename: file.name,
    owner,
    client: parsed.client,
    period: parsed.period,
    totalParsed: parsed.trades.length,
    tradesAdded: fresh.length,
    duplicatesSkipped: parsed.trades.length - fresh.length,
    countMatches: parsed.countMatches,
  });
}
