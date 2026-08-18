/**
 * Learning a parser for a broker we've never seen — the one path that costs an
 * LLM call.
 *
 * The model never sees the ledger and never parses the trades itself. It reads a
 * sample of the statement and writes a `BrokerParseSpec` (a regex plus a column
 * mapping); we then run that spec locally over the *whole* document and check the
 * arithmetic closes, the row count matches the report's own total, and nothing
 * that looks like a trade went unread. Only a spec that survives that gets saved,
 * and from then on the broker parses for free.
 *
 * If validation fails, the failures go back to the model verbatim (up to
 * `MAX_ATTEMPTS`), which is far more effective than re-asking blind.
 *
 * Two backends, chosen by environment (see `resolveProvider`): the Anthropic API,
 * or any OpenAI-compatible server — Ollama, LM Studio, llama.cpp, vLLM. Pointing it
 * at a local model means the statement sample never leaves the machine, which for
 * financial statements is the more interesting property of the two.
 */
import Anthropic from "@anthropic-ai/sdk";
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

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";
const MAX_ATTEMPTS = 3;
/**
 * Local models are slow — a reasoning model on consumer hardware can spend minutes
 * on one spec — and this runs once per broker, so wait rather than fail.
 * Override with LEARNING_TIMEOUT_MS.
 */
const DEFAULT_TIMEOUT_MS = 600_000;

/** Thrown when nothing is configured to learn with. */
export class LearningUnavailableError extends Error {}

/** Thrown when the model couldn't produce a spec that survives validation. */
export class LearningFailedError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------- the backend */

type Turn = { role: "user" | "assistant"; text: string };

interface Provider {
  /** Recorded against the profile, so you can see what wrote a given parser. */
  label: string;
  /** Ask for JSON matching `SPEC_SCHEMA`. Returns the raw JSON text. */
  complete(system: string, turns: Turn[]): Promise<string>;
}

/**
 * Which backend to learn with:
 *   LEARNING_BASE_URL  an OpenAI-compatible endpoint, e.g. http://localhost:11434/v1
 *                      (with LEARNING_MODEL naming the model). Wins when set.
 *   ANTHROPIC_API_KEY  the Anthropic API, on LEARNING_MODEL or claude-opus-5.
 */
function resolveProvider(): Provider | null {
  const baseUrl = process.env.LEARNING_BASE_URL?.replace(/\/$/, "");
  if (baseUrl) {
    const model = process.env.LEARNING_MODEL;
    if (!model) {
      throw new LearningUnavailableError(
        "LEARNING_BASE_URL is set but LEARNING_MODEL isn't — name the model to use.",
      );
    }
    return openAiCompatibleProvider(baseUrl, model, process.env.LEARNING_API_KEY);
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
    return anthropicProvider(process.env.LEARNING_MODEL || DEFAULT_ANTHROPIC_MODEL);
  }
  return null;
}

export function isLearningConfigured(): boolean {
  try {
    return resolveProvider() !== null;
  } catch {
    return false; // misconfigured counts as unavailable; the error explains why
  }
}

/** Where learning would run, for display. `null` when it can't. */
export function learningBackendLabel(): string | null {
  try {
    return resolveProvider()?.label ?? null;
  } catch {
    return null;
  }
}

function anthropicProvider(model: string): Provider {
  return {
    label: model,
    async complete(system, turns) {
      const client = new Anthropic();
      const message = await client.messages.create({
        model,
        max_tokens: 16000,
        system,
        output_config: { format: { type: "json_schema", schema: SPEC_SCHEMA } },
        messages: turns.map((t) => ({ role: t.role, content: t.text })),
      });
      return message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
    },
  };
}

/**
 * Read an OpenAI-style SSE stream down to its concatenated content.
 *
 * We stream even though we only want the final JSON: a local model can think for
 * minutes before its first token, and an unstreamed response sends no headers until
 * it finishes — which trips Node's 300s headers timeout regardless of our own.
 */
async function readStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let content = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });

    const lines = buffered.split("\n");
    buffered = lines.pop() ?? ""; // keep the partial line for the next chunk
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        content += chunk.choices?.[0]?.delta?.content ?? "";
      } catch {
        // A keepalive or a comment frame; nothing to add.
      }
    }
  }
  return content;
}

function timeoutMs(): number {
  const raw = Number(process.env.LEARNING_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Any server speaking OpenAI's /chat/completions with `response_format:
 * json_schema` — which is how Ollama, LM Studio, llama.cpp and vLLM all expose
 * grammar-constrained decoding.
 */
function openAiCompatibleProvider(baseUrl: string, model: string, apiKey?: string): Provider {
  const reasoningEffort = process.env.LEARNING_REASONING_EFFORT;
  return {
    label: `${model} (${new URL(baseUrl).host})`,
    async complete(system, turns) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Local servers ignore this; hosted ones need it.
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            ...turns.map((t) => ({ role: t.role, content: t.text })),
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "broker_parse_spec", strict: true, schema: SPEC_SCHEMA },
          },
          temperature: 0,
          stream: true,
          // Thinking generally earns its keep here — inferring a regex from a table
          // is exactly the kind of task it helps with — so it's left on unless asked
          // otherwise. Set LEARNING_REASONING_EFFORT=none to trade quality for speed
          // on a local reasoning model.
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      });

      if (!res.ok) {
        throw new Error(`${model} at ${baseUrl} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      if (!res.body) throw new Error(`${model} at ${baseUrl} returned an empty response.`);

      const content = await readStream(res.body);
      // Reasoning models sometimes leak a think block into the content despite the
      // schema; the JSON is what follows it.
      return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    },
  };
}

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

function parseAnswer(text: string): SpecDraft {
  if (!text.trim()) throw new Error("The model returned no spec.");
  try {
    return JSON.parse(text) as SpecDraft;
  } catch {
    // A schema-constrained answer should be bare JSON, but small models sometimes
    // wrap it in prose or a fence. Take the outermost object and try again.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("The model's answer wasn't JSON.");
    return JSON.parse(text.slice(start, end + 1)) as SpecDraft;
  }
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
}

/**
 * Ask the configured model for a parser for `text`, validate it locally, and hand
 * back the first spec that passes. Throws `LearningFailedError` if none does —
 * better to refuse the import than to write half-read trades into the ledger.
 *
 * A sample of the statement goes to whichever backend is configured, and nothing
 * else does. With a local model, that's still this machine.
 */
export async function learnParser(
  text: string,
  options: LearnOptions = {},
): Promise<LearnedParser> {
  const provider = resolveProvider();
  if (!provider) {
    throw new LearningUnavailableError(
      "Nothing is configured to learn a parser with. Set ANTHROPIC_API_KEY, or point LEARNING_BASE_URL and LEARNING_MODEL at a local model.",
    );
  }

  const turns: Turn[] = [{ role: "user", text: buildRequest(sampleForLearning(text)) }];
  let lastFailure = "the model did not return a usable spec";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const answer = await provider.complete(SYSTEM_PROMPT, turns);

    let spec: BrokerParseSpec;
    try {
      spec = specFromDraft(parseAnswer(answer));
    } catch (e) {
      lastFailure = (e as Error).message;
      options.onRejected?.({ attempt, answer, spec: null, errors: [lastFailure] });
      turns.push(
        { role: "assistant", text: answer },
        {
          role: "user",
          text: `That spec was rejected before it could run: ${lastFailure}\n\nReturn a corrected spec.`,
        },
      );
      continue;
    }

    const result = runSpec(text, spec);
    const validation = validateRun(result, spec);
    if (validation.ok) {
      return { spec, model: provider.label, attempts: attempt, result, validation };
    }

    lastFailure = validation.errors.join(" ");
    options.onRejected?.({ attempt, answer, spec, errors: validation.errors });
    turns.push(
      { role: "assistant", text: answer },
      { role: "user", text: buildRepairRequest(validation, result, spec) },
    );
  }

  throw new LearningFailedError(
    `Couldn't work out this statement's layout after ${MAX_ATTEMPTS} attempts. Last problem: ${lastFailure}`,
    MAX_ATTEMPTS,
  );
}
