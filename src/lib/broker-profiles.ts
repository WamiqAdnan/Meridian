/**
 * The parser registry: which broker's spec reads this statement?
 *
 * Order of attack, cheapest first:
 *   1. layout fingerprint → the one profile we've read this shape with before
 *   2. every stored spec, tried in turn (a broker tweaking its header, or a
 *      statement for a different client, lands here — still no LLM call)
 *   3. nothing matched → the caller learns a new spec (see `broker-learn.ts`)
 *
 * A match is only a match if `validateRun` passes on the *whole* document, so a
 * fingerprint collision or a drifted layout degrades to the next step instead of
 * writing bad rows to the ledger.
 */
import { prisma } from "@/lib/db";
import {
  assertValidSpec,
  runSpec,
  validateRun,
  type BrokerParseSpec,
  type SpecRunResult,
  type SpecValidation,
} from "@/lib/broker-spec";
import { BUILTIN_PROFILES } from "@/lib/builtin-brokers";

export interface ProfileRef {
  id: number;
  slug: string;
  broker: string;
  source: string;
  model: string | null;
}

export interface ParserMatch {
  profile: ProfileRef;
  spec: BrokerParseSpec;
  result: SpecRunResult;
  validation: SpecValidation;
  matchedBy: "fingerprint" | "scan";
}

function parseSpec(json: string): BrokerParseSpec | null {
  try {
    const spec = JSON.parse(json) as BrokerParseSpec;
    assertValidSpec(spec);
    return spec;
  } catch {
    return null; // a spec we can no longer honour is simply skipped
  }
}

function toRef(row: {
  id: number;
  slug: string;
  broker: string;
  source: string;
  model: string | null;
}): ProfileRef {
  return { id: row.id, slug: row.slug, broker: row.broker, source: row.source, model: row.model };
}

/** Seed/refresh the built-in profiles. Code is authoritative for their specs. */
export async function ensureBuiltinProfiles(): Promise<void> {
  for (const { slug, spec } of BUILTIN_PROFILES) {
    const spec_ = JSON.stringify(spec);
    await prisma.brokerProfile.upsert({
      where: { slug },
      create: { slug, broker: spec.broker, spec: spec_, source: "builtin", notes: spec.notes },
      update: { broker: spec.broker, spec: spec_, source: "builtin", notes: spec.notes },
    });
  }
}

/**
 * Find a stored parser that reads this statement cleanly, or `null` if none does.
 * `unmatchedReasons` collects why near-misses were rejected — useful context for
 * the learning prompt and for telling the user what went wrong.
 */
export async function resolveParser(
  text: string,
  fingerprint: string,
  unmatchedReasons: string[] = [],
): Promise<ParserMatch | null> {
  await ensureBuiltinProfiles();

  const attempt = (
    profile: ProfileRef,
    spec: BrokerParseSpec,
    matchedBy: ParserMatch["matchedBy"],
  ): ParserMatch | null => {
    let result: SpecRunResult;
    try {
      result = runSpec(text, spec);
    } catch (e) {
      unmatchedReasons.push(`${profile.broker}: ${(e as Error).message}`);
      return null;
    }
    const validation = validateRun(result, spec);
    if (!validation.ok) {
      // Only worth reporting when the spec clearly *tried* — otherwise it's just
      // "this is a different broker", which isn't a problem.
      if (result.trades.length > 0) {
        unmatchedReasons.push(`${profile.broker}: ${validation.errors.join(" ")}`);
      }
      return null;
    }
    return { profile, spec, result, validation, matchedBy };
  };

  const known = await prisma.brokerFingerprint.findUnique({
    where: { hash: fingerprint },
    include: { profile: true },
  });
  if (known) {
    const spec = parseSpec(known.profile.spec);
    if (spec) {
      const match = attempt(toRef(known.profile), spec, "fingerprint");
      if (match) return match;
    }
  }

  const profiles = await prisma.brokerProfile.findMany({
    orderBy: [{ useCount: "desc" }, { id: "asc" }],
  });
  for (const row of profiles) {
    if (known && row.id === known.profileId) continue; // already tried
    const spec = parseSpec(row.spec);
    if (!spec) continue;
    const match = attempt(toRef(row), spec, "scan");
    if (match) return match;
  }

  return null;
}

export interface KnownParser {
  slug: string;
  broker: string;
  source: string;
  useCount: number;
}

/**
 * Every parser the app can currently use, for display. Read-only: built-ins that
 * haven't been seeded yet are merged in from code rather than written, so rendering
 * a page never mutates the database.
 */
export async function listKnownParsers(): Promise<KnownParser[]> {
  const rows = await prisma.brokerProfile.findMany({
    select: { slug: true, broker: true, source: true, useCount: true },
  });
  const bySlug = new Map(rows.map((r) => [r.slug, r as KnownParser]));
  for (const { slug, spec } of BUILTIN_PROFILES) {
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { slug, broker: spec.broker, source: "builtin", useCount: 0 });
    }
  }
  return [...bySlug.values()].sort((a, b) => a.broker.localeCompare(b.broker));
}

/** Note that a profile just read a statement, and remember this layout for next time. */
export async function recordParserUse(profileId: number, fingerprint: string): Promise<void> {
  await prisma.brokerFingerprint.upsert({
    where: { hash: fingerprint },
    create: { hash: fingerprint, profileId },
    update: { profileId },
  });
  await prisma.brokerProfile.update({
    where: { id: profileId },
    data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
  });
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "broker";
}

/** Persist a freshly learned spec under a free slug, and claim this fingerprint. */
export async function saveLearnedProfile(args: {
  spec: BrokerParseSpec;
  model: string;
  fingerprint: string;
}): Promise<ProfileRef> {
  const base = slugify(args.spec.broker);
  let slug = base;
  for (let n = 2; await prisma.brokerProfile.findUnique({ where: { slug } }); n++) {
    slug = `${base}-${n}`;
  }

  const row = await prisma.brokerProfile.create({
    data: {
      slug,
      broker: args.spec.broker,
      spec: JSON.stringify(args.spec),
      source: "llm",
      model: args.model,
      notes: args.spec.notes ?? null,
      useCount: 1,
      lastUsedAt: new Date(),
      fingerprints: { create: { hash: args.fingerprint } },
    },
  });
  return toRef(row);
}
