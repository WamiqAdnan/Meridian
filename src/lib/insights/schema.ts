/**
 * What the model is allowed to say, and how we check that it said only that.
 *
 * This is the load-bearing file of the insight engine. The model's answer is
 * constrained by `INSIGHT_SCHEMA` on the way out and checked by `validateInsight`
 * on the way in, and the checks are not about JSON shape — the schema already
 * handles that. They are about honesty:
 *
 *   - every movement it discusses is one we gave it, and every one we gave it is
 *     discussed exactly once;
 *   - every article it cites is one we retrieved;
 *   - a verdict of "explained" must cite something, and a verdict of
 *     "insufficient" must cite nothing — the two cannot be quietly mixed;
 *   - a *high* confidence claim needs an article a publisher actually filed
 *     against that instrument, or one that names its ticker. A hand-written
 *     synonym appearing in a headline is not enough to be sure about, ever;
 *   - and every percentage in its prose has to be a number we handed it. This is
 *     the anti-fabrication check that matters most, because a plausible invented
 *     figure is the failure a reader cannot catch.
 *
 * Nothing here asks the model whether it is confident. It answers, and then the
 * answer is measured against the evidence it was given.
 *
 * Pure — no Prisma, no fetch, no model. Exercised end to end by
 * `scripts/check-insights.ts`.
 */
import type { EvidencePack, InsightDraft, MovementReading } from "./types";
import { CONFIDENCES, VERDICTS } from "./types";

/* ----------------------------------------------------------------- limits */

/** Caps, in characters. Generous enough not to fight the model, tight enough to matter. */
export const LIMITS = {
  headline: 120,
  summary: 700,
  inference: 500,
  watchItem: 160,
  watchItems: 4,
  citations: 5,
} as const;

/**
 * How far a quoted percentage may sit from the fact it claims to be.
 *
 * Rounding is expected — "gold fell 3.4%" for a 3.41% move is good writing, not a
 * fabrication. A figure that matches nothing we supplied, however, was invented.
 */
const FIGURE_TOLERANCE = 0.05;

/* ----------------------------------------------------------------- schema */

/**
 * The model's answer, as JSON Schema.
 *
 * Flat, fully-required, enums instead of free strings — the subset structured
 * outputs accepts, and the shape a small local model handles best. Same
 * discipline as `SPEC_SCHEMA` in `broker-learn.ts`, and asserted the same way by
 * the check script so a 400 never turns up at generation time.
 */
export const INSIGHT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "movements", "watchItems"],
  properties: {
    headline: {
      type: "string",
      description:
        "One line on the week for this market. No figures unless they appear in the FACTS block.",
    },
    summary: {
      type: "string",
      description:
        "Two to four sentences on what the retrieved headlines suggest about the week as a whole. Say what the headlines report, not what caused what.",
    },
    movements: {
      type: "array",
      description: "Exactly one entry for every M-ref in the FACTS block.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ref", "verdict", "inference", "citations", "confidence"],
        properties: {
          ref: { type: "string", description: "A movement reference from the FACTS block, e.g. M1." },
          verdict: {
            type: "string",
            enum: ["explained", "partial", "insufficient"],
            description:
              "explained: the cited headlines plausibly account for the move. partial: they bear on it but leave most of it unaccounted for. insufficient: nothing retrieved explains it — cite nothing.",
          },
          inference: {
            type: "string",
            description:
              "What the cited headlines suggest about this move, or what you looked for and did not find. Never assert a cause as fact.",
          },
          citations: {
            type: "array",
            description: "Article references from the HEADLINES block, e.g. A3. Empty when the verdict is insufficient.",
            items: { type: "string" },
          },
          confidence: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "high requires a headline the publisher filed against this instrument, or one naming its ticker.",
          },
        },
      },
    },
    watchItems: {
      type: "array",
      description: "Up to four short things a holder of these assets should watch next. Optional.",
      items: { type: "string" },
    },
  },
} as const;

/* ------------------------------------------------------------- validation */

export type InsightValidation =
  | { ok: true; value: InsightDraft }
  | { ok: false; errors: string[] };

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

/** Percentages written in prose, with the text so we know what precision was meant. */
function quotedFigures(text: string): { raw: string; value: number }[] {
  const out: { raw: string; value: number }[] = [];
  for (const m of text.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)) {
    const value = Number(m[1]);
    if (Number.isFinite(value)) out.push({ raw: m[1], value });
  }
  return out;
}

function decimalsOf(raw: string): number {
  const dot = raw.indexOf(".");
  return dot === -1 ? 0 : raw.length - dot - 1;
}

/**
 * Whether a quoted percentage is one of the figures we supplied.
 *
 * Compared on magnitude: direction lives in the verb ("fell 3.4%"), and the fact
 * itself is rendered right beside the sentence, so a reversed sign is visible in a
 * way an invented magnitude is not.
 */
function supportedFigure(quoted: { raw: string; value: number }, allowed: number[]): boolean {
  const q = Math.abs(quoted.value);
  const dp = decimalsOf(quoted.raw);
  return allowed.some((a) => {
    const actual = Math.abs(a);
    if (Math.abs(actual - q) <= FIGURE_TOLERANCE) return true;
    return Number(actual.toFixed(dp)) === Number(q.toFixed(dp));
  });
}

/** Every percentage the model is entitled to write. */
export function supportedFigures(pack: EvidencePack): number[] {
  const values: number[] = [];
  for (const m of pack.movements) {
    values.push(m.changePct, m.sigma);
    if (m.weekChangePct != null) values.push(m.weekChangePct);
  }
  if (pack.marketChangePct != null) values.push(pack.marketChangePct);
  return values;
}

/**
 * Check a parsed answer against the evidence it was given.
 *
 * Returns every problem it finds rather than the first, because the whole list
 * goes back to the model and fixing one at a time wastes attempts.
 */
export function validateInsight(draft: unknown, pack: EvidencePack): InsightValidation {
  const errors: string[] = [];
  if (!draft || typeof draft !== "object") {
    return { ok: false, errors: ["The answer was not an object."] };
  }
  const d = draft as Record<string, unknown>;

  const headline = typeof d.headline === "string" ? d.headline.trim() : "";
  const summary = typeof d.summary === "string" ? d.summary.trim() : "";
  if (!headline) errors.push("headline is missing or empty.");
  if (!summary) errors.push("summary is missing or empty.");
  if (headline.length > LIMITS.headline) {
    errors.push(`headline is ${headline.length} characters; keep it under ${LIMITS.headline}.`);
  }
  if (summary.length > LIMITS.summary) {
    errors.push(`summary is ${summary.length} characters; keep it under ${LIMITS.summary}.`);
  }

  const watchItems = isStringArray(d.watchItems) ? d.watchItems.map((s) => s.trim()).filter(Boolean) : [];
  if (d.watchItems !== undefined && !isStringArray(d.watchItems)) {
    errors.push("watchItems must be an array of strings.");
  }
  if (watchItems.length > LIMITS.watchItems) {
    errors.push(`watchItems has ${watchItems.length} entries; keep it to ${LIMITS.watchItems}.`);
  }
  for (const item of watchItems) {
    if (item.length > LIMITS.watchItem) {
      errors.push(`a watch item is ${item.length} characters; keep each under ${LIMITS.watchItem}.`);
    }
  }

  const byRef = new Map(pack.movements.map((m) => [m.ref, m]));
  const articleRefs = new Set(pack.articles.map((a) => a.ref));
  /** Which assets an article is *linked* to, and how — the provenance check below. */
  const linksByArticle = new Map(pack.articles.map((a) => [a.ref, a.links]));

  const readings: MovementReading[] = [];
  const seen = new Set<string>();

  if (!Array.isArray(d.movements)) {
    errors.push("movements must be an array.");
  } else {
    for (const raw of d.movements) {
      if (!raw || typeof raw !== "object") {
        errors.push("a movements entry was not an object.");
        continue;
      }
      const r = raw as Record<string, unknown>;
      const ref = typeof r.ref === "string" ? r.ref.trim().toUpperCase() : "";
      const fact = byRef.get(ref);
      if (!fact) {
        errors.push(
          `movements names "${r.ref}", which is not in the FACTS block. Use only the M-refs listed there.`,
        );
        continue;
      }
      if (seen.has(ref)) {
        errors.push(`${ref} appears more than once; give exactly one entry per movement.`);
        continue;
      }
      seen.add(ref);

      const verdict = typeof r.verdict === "string" ? r.verdict : "";
      if (!(VERDICTS as readonly string[]).includes(verdict)) {
        errors.push(`${ref} has verdict "${verdict}"; use one of ${VERDICTS.join(", ")}.`);
        continue;
      }
      const confidence = typeof r.confidence === "string" ? r.confidence : "";
      if (!(CONFIDENCES as readonly string[]).includes(confidence)) {
        errors.push(`${ref} has confidence "${confidence}"; use one of ${CONFIDENCES.join(", ")}.`);
        continue;
      }

      const inference = typeof r.inference === "string" ? r.inference.trim() : "";
      if (!inference) errors.push(`${ref} has no inference; say what you found, or what you didn't.`);
      if (inference.length > LIMITS.inference) {
        errors.push(`${ref}'s inference is ${inference.length} characters; keep it under ${LIMITS.inference}.`);
      }

      const rawCitations = isStringArray(r.citations) ? r.citations : [];
      if (!isStringArray(r.citations)) errors.push(`${ref}'s citations must be an array of strings.`);
      const citations = [...new Set(rawCitations.map((c) => c.trim().toUpperCase()))];
      for (const c of citations) {
        if (!articleRefs.has(c)) {
          errors.push(
            `${ref} cites "${c}", which is not in the HEADLINES block. Cite only the A-refs listed there.`,
          );
        }
      }
      if (citations.length > LIMITS.citations) {
        errors.push(`${ref} cites ${citations.length} articles; cite at most ${LIMITS.citations}.`);
      }

      // A verdict and its evidence have to agree. This is the rule that keeps
      // "insufficient" honest: it cannot be hedged with a citation, and
      // "explained" cannot be asserted without one.
      if (verdict === "insufficient" && citations.length > 0) {
        errors.push(
          `${ref} is marked insufficient but cites ${citations.join(", ")}. If those headlines bear on the move, say "partial"; otherwise cite nothing.`,
        );
      }
      if (verdict !== "insufficient" && citations.length === 0) {
        errors.push(`${ref} is marked ${verdict} but cites nothing. Cite the headlines you read, or say insufficient.`);
      }

      // Provenance gates confidence. An article a publisher filed against this
      // instrument, or one naming its ticker, can support a confident claim; a
      // headline that merely contains a synonym cannot, however apt it reads.
      if (confidence === "high") {
        const strong = citations.some((c) =>
          (linksByArticle.get(c) ?? []).some(
            (l) => l.ref === ref && (l.via === "feed" || l.via === "symbol"),
          ),
        );
        if (!strong) {
          errors.push(
            `${ref} claims high confidence, but none of its citations was filed against ${fact.symbol} by a publisher or names its ticker. Use medium or low.`,
          );
        }
      }

      readings.push({ ref, verdict: verdict as MovementReading["verdict"], inference, citations, confidence: confidence as MovementReading["confidence"] });
    }
  }

  for (const m of pack.movements) {
    if (!seen.has(m.ref)) {
      errors.push(`${m.ref} (${m.symbol}) is in the FACTS block but has no entry. Cover every movement.`);
    }
  }

  // Every figure in prose has to be one we supplied. Checked last so the message
  // is specific about which sentence invented it.
  const allowed = supportedFigures(pack);
  const prose: [string, string][] = [
    ["headline", headline],
    ["summary", summary],
    ...readings.map((r): [string, string] => [`${r.ref}'s inference`, r.inference]),
    ...watchItems.map((w, i): [string, string] => [`watch item ${i + 1}`, w]),
  ];
  for (const [where, text] of prose) {
    for (const figure of quotedFigures(text)) {
      if (!supportedFigure(figure, allowed)) {
        errors.push(
          `${where} quotes ${figure.raw}%, which is not one of the figures in the FACTS block. Use only figures given to you, or none.`,
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Answer in the order the facts were presented, not the order they came back.
  const order = new Map(pack.movements.map((m, i) => [m.ref, i]));
  readings.sort((a, b) => (order.get(a.ref) ?? 0) - (order.get(b.ref) ?? 0));

  return { ok: true, value: { headline, summary, movements: readings, watchItems } };
}
