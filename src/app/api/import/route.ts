import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { INVESTORS, isInvestor } from "@/lib/investors";
import { extractStatementText, fingerprintLayout } from "@/lib/statement-text";
import type { BrokerParseSpec, ParsedTrade } from "@/lib/broker-spec";
import {
  recordParserUse,
  resolveParser,
  saveLearnedProfile,
  type ProfileRef,
} from "@/lib/broker-profiles";
import {
  LearningFailedError,
  LearningUnavailableError,
  isLearningConfigured,
  learnParser,
} from "@/lib/broker-learn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Learning a new broker's layout is up to three model calls, and a local model can
 * spend minutes on each. Only hosting platforms enforce this; locally the request
 * simply stays open.
 */
export const maxDuration = 900;

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

  let text: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    text = await extractStatementText(buffer, file.name, file.type);
  } catch (e) {
    return NextResponse.json(
      { error: `Could not read the file: ${(e as Error).message}` },
      { status: 422 },
    );
  }
  if (text.trim().length === 0) {
    return NextResponse.json(
      { error: "No text could be extracted — is this a scanned image rather than a text PDF?" },
      { status: 422 },
    );
  }

  const fingerprint = fingerprintLayout(text);

  // 1. A parser we already have. The common case, and free.
  const nearMisses: string[] = [];
  const match = await resolveParser(text, fingerprint, nearMisses);

  let profile: ProfileRef;
  let spec: BrokerParseSpec;
  let trades: ParsedTrade[];
  let client: string | null;
  let period: string | null;
  let countMatches: boolean;
  let warnings: string[];
  let learned = false;

  if (match) {
    ({ profile, spec } = match);
    ({ trades, client, period, countMatches } = match.result);
    warnings = match.validation.warnings;
    await recordParserUse(profile.id, fingerprint);
  } else {
    // 2. Nothing reads this statement — learn a parser for it, once.
    if (!isLearningConfigured()) {
      return NextResponse.json(
        {
          error:
            "This doesn't match any broker layout we know, and nothing is configured to learn a new one. Set ANTHROPIC_API_KEY in .env, or point LEARNING_BASE_URL and LEARNING_MODEL at a local model, then restart and upload again.",
          details: nearMisses,
        },
        { status: 422 },
      );
    }

    try {
      const outcome = await learnParser(text);
      spec = outcome.spec;
      ({ trades, client, period, countMatches } = outcome.result);
      warnings = outcome.validation.warnings;
      profile = await saveLearnedProfile({
        spec: outcome.spec,
        model: outcome.model,
        fingerprint,
      });
      learned = true;
    } catch (e) {
      if (e instanceof LearningUnavailableError || e instanceof LearningFailedError) {
        return NextResponse.json({ error: e.message, details: nearMisses }, { status: 422 });
      }
      return NextResponse.json(
        { error: `Learning this broker's layout failed: ${(e as Error).message}` },
        { status: 502 },
      );
    }
  }

  if (trades.length === 0) {
    return NextResponse.json(
      { error: `Read this as a ${spec.broker} statement but found no trades in it.` },
      { status: 422 },
    );
  }

  // Dedup within the broker: two brokers numbering from 1 must not collide.
  const existing = await prisma.transaction.findMany({
    where: { broker: profile.slug, tradeNo: { in: trades.map((t) => t.tradeNo) } },
    select: { tradeNo: true },
  });
  const existingSet = new Set(existing.map((e) => e.tradeNo));
  const fresh = trades.filter((t) => !existingSet.has(t.tradeNo));

  if (fresh.length > 0) {
    await prisma.transaction.createMany({
      data: fresh.map((t) => ({
        owner,
        broker: profile.slug,
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
      broker: profile.slug,
      parser: learned ? "learned" : "reused",
      filename: file.name,
      totalParsed: trades.length,
      tradesAdded: fresh.length,
      duplicatesSkipped: trades.length - fresh.length,
    },
  });

  return NextResponse.json({
    filename: file.name,
    owner,
    broker: spec.broker,
    brokerSlug: profile.slug,
    parser: learned ? "learned" : match?.matchedBy === "fingerprint" ? "known" : "matched",
    parserModel: learned ? profile.model : null,
    parserNotes: learned ? spec.notes ?? null : null,
    client,
    period,
    totalParsed: trades.length,
    tradesAdded: fresh.length,
    duplicatesSkipped: trades.length - fresh.length,
    countMatches,
    warnings,
  });
}
