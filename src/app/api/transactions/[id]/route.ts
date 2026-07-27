import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isInvestor } from "@/lib/investors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reassign a trade to a different investor (fixes mistags / splits a mixed report). */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) {
    return NextResponse.json({ error: "Invalid transaction id." }, { status: 400 });
  }
  let owner: unknown;
  try {
    ({ owner } = await req.json());
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (!isInvestor(owner)) {
    return NextResponse.json({ error: "Invalid owner." }, { status: 400 });
  }
  try {
    await prisma.transaction.update({ where: { id: numId }, data: { owner } });
  } catch {
    return NextResponse.json({ error: "Transaction not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) {
    return NextResponse.json({ error: "Invalid transaction id." }, { status: 400 });
  }
  try {
    await prisma.transaction.delete({ where: { id: numId } });
  } catch {
    return NextResponse.json({ error: "Transaction not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
