/**
 * Learning a parser for a broker we've never seen — the one import path that costs
 * an LLM call.
 *
 * The model never sees the ledger and never parses the trades itself. It reads a
 * sample of the statement and writes a `BrokerParseSpec` (a regex plus a column
 * mapping); we then run that spec locally over the *whole* document and check the
 * arithmetic closes, the row count matches the report's own total, and nothing
 * that looks like a trade went unread. Only a spec that survives that gets saved,
 * and from then on the broker parses for free.
 *
 * If validation fails, the failures go back to the model verbatim, which is far
 * more effective than re-asking blind. That ask-validate-repair loop, and the
 * choice of backend behind it, now live in `src/lib/ai/` — this file is the part
 * that is about broker statements: the schema, the prompt, and what makes a spec
 * good enough to keep.
 */
import {
  runStructuredTask,
  type AiProvider,
  type Review,
} from "@/lib/ai";
import {
  assertValidSpec,
  diagnosePattern,
  runSpec,
  validateRun,
  type BrokerParseSpec,
  type DateFormat,
  type Side,
  type SideRule,
  type SpecRunResult,
  type SpecValidation,
} from "@/lib/broker-spec";
import { sampleForLearning } from "@/lib/statement-text";

const MAX_ATTEMPTS = 3;

/** Generous: a spec is one flat JSON object, but a big statement makes a long one. */
const MAX_TOKENS = 16000;

/* ------------------------------------------------------------ output shape */

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const;

/**
 * The model's answer, as JSON Schema. Flat, fully-required, nulls instead of
 * optionals — the shapes structured outputs handles best. `specFromDraft` folds it
 * into the internal `BrokerParseSpec`.
 *
 * Exported so `scripts/check-parse.ts` can assert it stays within the subset
 * structured outputs accepts, without making an API call to find out.
 */
export const SPEC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "broker",
    "rowPattern",
    "dateFormat",
    "decimalSeparator",
    "sideRule",
    "qtyGroup",
    "rateGroup",
    "grossGroup",
    "netGroup",
    "brokerageGroups",
    "cvtGroups",
    "metadata",
    "ignorePatterns",
    "notes",
  ],
  properties: {
    broker: { type: "string", description: "Broker's name as printed on the statement." },
    rowPattern: {
      type: "string",
      description:
        "JavaScript regex with named capture groups, matched against each trimmed line.",
    },
    dateFormat: { type: "string", enum: ["iso", "dmy", "mdy", "monthName"] },
    decimalSeparator: { type: "string", enum: [".", ","] },
    sideRule: {
      type: "object",
      additionalProperties: false,
      required: ["type", "group", "map", "value", "buyGroup", "sellGroup"],
      properties: {
        type: { type: "string", enum: ["map", "fixed", "signedQty", "buySellColumns"] },
        group: nullableString,
        map: {
          anyOf: [
            {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["token", "side"],
                properties: {
                  token: { type: "string", description: "Exactly as the statement writes it." },
                  side: { type: "string", enum: ["BUY", "SELL"] },
                },
              },
            },
            { type: "null" },
          ],
        },
        value: { anyOf: [{ type: "string", enum: ["BUY", "SELL"] }, { type: "null" }] },
        buyGroup: nullableString,
        sellGroup: nullableString,
      },
    },
    qtyGroup: nullableString,
    rateGroup: { type: "string" },
    grossGroup: nullableString,
    netGroup: nullableString,
    brokerageGroups: { type: "array", items: { type: "string" } },
    cvtGroups: { type: "array", items: { type: "string" } },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: ["clientPattern", "periodPattern", "totalRecordsPattern"],
      properties: {
        clientPattern: nullableString,
        periodPattern: nullableString,
        totalRecordsPattern: nullableString,
      },
    },
    ignorePatterns: { type: "array", items: { type: "string" } },
    notes: { type: "string", description: "One or two sentences on how this layout reads." },
  },
} as const;

/** The model's answer, shaped by SPEC_SCHEMA. */
export interface SpecDraft {
  broker: string;
  rowPattern: string;
  dateFormat: DateFormat;
  decimalSeparator: "." | ",";
  sideRule: {
    type: SideRule["type"];
    group: string | null;
    map: { token: string; side: Side }[] | null;
    value: Side | null;
    buyGroup: string | null;
    sellGroup: string | null;
  };
  qtyGroup: string | null;
  rateGroup: string;
  grossGroup: string | null;
  netGroup: string | null;
  brokerageGroups: string[];
  cvtGroups: string[];
  metadata: {
    clientPattern: string | null;
    periodPattern: string | null;
    totalRecordsPattern: string | null;
  };
  ignorePatterns: string[];
  notes: string;
}

/** Fold the model's flat answer into an internal spec, or throw if it can't stand up. */
export function specFromDraft(draft: SpecDraft): BrokerParseSpec {
  let sideRule: SideRule;
  switch (draft.sideRule.type) {
    case "fixed":
      sideRule = { type: "fixed", value: draft.sideRule.value ?? "BUY" };
      break;
    case "signedQty":
      sideRule = { type: "signedQty" };
      break;
    case "buySellColumns":
      sideRule = {
        type: "buySellColumns",
        buyGroup: draft.sideRule.buyGroup ?? "",
        sellGroup: draft.sideRule.sellGroup ?? "",
      };
      break;
    default:
      sideRule = {
        type: "map",
        group: draft.sideRule.group ?? "",
        map: Object.fromEntries((draft.sideRule.map ?? []).map((e) => [e.token, e.side])),
      };
  }

  const spec: BrokerParseSpec = {
    version: 1,
    broker: draft.broker.trim(),
    rowPattern: draft.rowPattern,
    dateFormat: draft.dateFormat,
    decimalSeparator: draft.decimalSeparator,
    sideRule,
    qtyGroup: draft.qtyGroup,
    rateGroup: draft.rateGroup,
    grossGroup: draft.grossGroup,
    netGroup: draft.netGroup,
    brokerageGroups: draft.brokerageGroups ?? [],
    cvtGroups: draft.cvtGroups ?? [],
    metadata: draft.metadata ?? {
      clientPattern: null,
      periodPattern: null,
      totalRecordsPattern: null,
    },
    ignorePatterns: draft.ignorePatterns ?? [],
    notes: draft.notes,
  };
  assertValidSpec(spec);
  return spec;
}

/* ---------------------------------------------------------------- the ask */

const SYSTEM_PROMPT = `You write parsers for stockbroker trade statements, as a declarative spec rather than code. Your spec runs against the whole statement, so it must read every trade row, not just the ones you can see.

The spec's rowPattern is a JavaScript regex, applied with \`new RegExp(pattern)\` to each line of the extracted text, one line at a time, already trimmed. No flags are set, so it is case-sensitive and \`^\`/\`$\` bound the line. Anchor it with ^ and $.

Name the capture groups. These names are required: security (the ticker), tradeNo (the broker's unique reference for the trade), tradeDate. Add settlementDate when the statement has one — it falls back to the trade date otherwise. Name the rest whatever describes the column, then map them with rateGroup, qtyGroup, grossGroup, netGroup, brokerageGroups and cvtGroups. A column you capture but don't map is simply ignored, which is the right move for columns like a per-share commission that is only the total commission divided by quantity.

Every one of those mapping fields holds the name of one of your own capture groups — never a column heading copied off the statement. For rows printed like:

  Ref     Date         Scrip    Type  Units  Rate    Amount      Charges  Settled
  55210   02-Jul-2026  ENGROH   Buy   400    285.90  114,360.00  286.00   114,646.00

a correct spec is:

  rowPattern: ^(?<tradeNo>\\d+)\\s+(?<tradeDate>\\d{2}-[A-Za-z]{3}-\\d{4})\\s+(?<security>[A-Z][A-Z0-9]*)\\s+(?<dealType>Buy|Sale)\\s+(?<units>[\\d,]+)\\s+(?<price>[\\d.,]+)\\s+(?<amount>[\\d.,]+)\\s+(?<charges>[\\d.,]+)\\s+(?<settled>[\\d.,]+)$
  dateFormat: monthName, sideRule: map on group "dealType" with Buy -> BUY and Sale -> SELL
  qtyGroup: units, rateGroup: price, grossGroup: amount, netGroup: settled
  brokerageGroups: [charges], cvtGroups: []

Note rateGroup is "price", the group you named — not "Rate", the heading. cvtGroups is empty because that statement prints no capital value tax; never invent a group for a column that isn't there.

Choosing sideRule:
- "map" — some column holds a word or letter for the side (BUY/SELL, B/S, Buy/Sale, P/S). This is almost always the right answer. Point group at that capture group and map every token the statement actually uses.
- "buySellColumns" — the statement has two separate quantity columns, one filled on purchases and the other on sales. Only when there really are two quantity columns.
- "signedQty" — one quantity column that goes negative for sales.
- "fixed" — the statement holds one side throughout, with no column distinguishing them.

Field rules:
- rateGroup: execution price per share. Required.
- qtyGroup: quantity traded. Required unless sideRule.type is "buySellColumns".
- grossGroup: consideration before fees (rate × quantity). Null if the statement doesn't print it — it will be computed.
- netGroup: amount actually settled, after fees. Null if not printed — it will be computed as gross ± fees.
- brokerageGroups: every charge that is a broker fee, summed. Commission, plus anything without a column of its own (SST, FED, sales tax, CDC, transaction charges). Prefer a total-commission column over a per-share one.
- cvtGroups: capital value tax only.
- metadata patterns: single-line regexes with one capture group named "value", for the client name, the statement period, and the printed total row count. Null if absent. The row-count pattern matters most — it is checked against how many rows we read.
- ignorePatterns: regexes for lines that resemble trade rows but are not (subtotals, carry-forwards, page footers with dates and figures). Leave empty unless a validation failure tells you a specific line needs skipping.

Writing a pattern that survives the next statement, not just this one:
- The text comes from PDF extraction, so column gaps are unpredictable. Always separate columns with \\s+, never a literal space count.
- Be permissive inside numeric columns: [\\d.,]+ tolerates thousands separators and both decimal styles. Allow an optional leading - or a (…) wrapper where a figure could be negative. Do not hand-build a thousands-separator pattern: \\d{1,3}(?:,\\d{3})* looks right and then fails on 212.40, because one column holds grouped integers and the next holds decimals.
- A column that is blank in this statement can carry a value in the next one. Make it optional — (?:\\s+\\S+)? — rather than assuming it is always empty.
- Do not nest quantifiers ((\\d+)+ and friends); those patterns are rejected.

Your spec is then validated on the full document, and only saved if all of this holds: at least one row read; every row has a positive rate and quantity, valid dates, and a settlement date no earlier than the trade date; trade numbers unique within the statement; the row count equal to the statement's own printed total; gross within 1% of rate × quantity; and no unread line that looks like a trade row. Aim at those checks directly — a spec that drops rows is worse than no spec.`;

function buildRequest(sample: string): string {
  return `Here is the extracted text of a broker trade statement — the header, then a window of rows. Write the spec that reads it.

<statement>
${sample}
</statement>`;
}

function buildRepairRequest(
  validation: SpecValidation,
  result: SpecRunResult,
  spec: BrokerParseSpec,
): string {
  const parts: string[] = [
    "That spec was run against the full statement and rejected:",
    validation.errors.map((e) => `- ${e}`).join("\n"),
  ];
  if (result.unmatched.length > 0) {
    parts.push(
      `Lines that look like trade rows but your pattern did not match (up to 5 of ${result.unmatched.length}):\n` +
        result.unmatched
          .slice(0, 5)
          .map((l) => `  ${l.slice(0, 200)}`)
          .join("\n"),
    );

    // Say where the pattern breaks, not just that it broke.
    const diagnosis = diagnosePattern(spec.rowPattern, result.unmatched[0]);
    if (diagnosis) {
      parts.push(
        diagnosis.lastMatched === null
          ? `Your pattern fails on that line immediately — nothing before the "${diagnosis.failedAt}" group matches. The line begins: ${diagnosis.remainder.slice(0, 80)}`
          : `On that line your pattern matches as far as the "${diagnosis.lastMatched}" group, consuming: ${diagnosis.consumed.slice(-60)}\n` +
            `It then fails at the "${diagnosis.failedAt}" group, where the rest of the line reads: ${diagnosis.remainder.slice(0, 80)}\n` +
            `Fix the "${diagnosis.failedAt}" group so it accepts that text.`,
      );
    }
  }
  if (result.rowErrors.length > 0) {
    parts.push(
      `Rows that matched but produced unusable values (up to 3 of ${result.rowErrors.length}):\n` +
        result.rowErrors
          .slice(0, 3)
          .map((l) => `  ${l}`)
          .join("\n"),
    );
  }
  parts.push(
    `It read ${result.trades.length} trade(s)${
      result.totalRecords !== null ? ` against a stated total of ${result.totalRecords}` : ""
    }. Diagnose the mismatch and return a corrected spec.`,
  );
  return parts.join("\n\n");
}

export interface LearnedParser {
  spec: BrokerParseSpec;
  model: string;
  attempts: number;
  result: SpecRunResult;
  validation: SpecValidation;
}

export interface LearnOptions {
  /**
   * Called after each rejected attempt. Only for the dry-run harness
   * (`scripts/try-learn.ts`) — the import route doesn't need it, but seeing which
   * spec was rejected and why is the difference between "the model failed" and
   * knowing whether the prompt is at fault.
   */
  onRejected?: (info: {
    attempt: number;
    answer: string;
    spec: BrokerParseSpec | null;
    errors: string[];
  }) => void;
  /** Overridable so a check script can drive the loop offline. */
  provider?: AiProvider;
}

/**
 * Ask the configured model for a parser for `text`, validate it locally, and hand
 * back the first spec that passes. Throws `StructuredTaskError` if none does —
 * better to refuse the import than to write half-read trades into the ledger.
 *
 * A sample of the statement goes to whichever backend is configured, and nothing
 * else does. With a local model, that's still this machine.
 */
export async function learnParser(
  text: string,
  options: LearnOptions = {},
): Promise<LearnedParser> {
  // The reviewer knows the spec it just rejected; `onRejected` is handed it so the
  // harness can print the pattern that failed rather than only the complaint.
  let lastSpec: BrokerParseSpec | null = null;

  const outcome = await runStructuredTask<LearnedParser>({
    system: SYSTEM_PROMPT,
    request: buildRequest(sampleForLearning(text)),
    schema: SPEC_SCHEMA,
    schemaName: "broker_parse_spec",
    maxTokens: MAX_TOKENS,
    maxAttempts: MAX_ATTEMPTS,
    provider: options.provider,
    review: (draft): Review<LearnedParser> => {
      lastSpec = null;

      let spec: BrokerParseSpec;
      try {
        spec = specFromDraft(draft as SpecDraft);
      } catch (e) {
        return {
          ok: false,
          errors: [(e as Error).message],
          repair: `That spec was rejected before it could run: ${(e as Error).message}\n\nReturn a corrected spec.`,
        };
      }
      lastSpec = spec;

      // The real test: run it over the whole document, not the sample the model saw.
      const result = runSpec(text, spec);
      const validation = validateRun(result, spec);
      if (validation.ok) {
        return {
          ok: true,
          // `model` and `attempts` are filled in from the outcome below.
          value: { spec, model: "", attempts: 0, result, validation },
        };
      }
      return {
        ok: false,
        errors: validation.errors,
        repair: buildRepairRequest(validation, result, spec),
      };
    },
    onRejected: ({ attempt, answer, errors }) =>
      options.onRejected?.({ attempt, answer, spec: lastSpec, errors }),
  });

  return { ...outcome.value, model: outcome.model, attempts: outcome.attempts };
}
