/**
 * Standalone checks for the statement parser: the spec engine's scalars, the
 * built-in Finqalab spec against the real sample PDF, the validator's ability to
 * reject a plausible-but-wrong spec, and one synthetic foreign layout proving the
 * engine reads brokers it wasn't written for.
 *
 * Run: npm run check:parse
 *
 * The Finqalab expectations come from data/reference/transactions.csv — the
 * checked-in ledger export. If a change to the engine moves a single field, that's
 * the point.
 */
import { readFileSync } from "node:fs";
import {
  diagnosePattern,
  normalizeDate,
  parseAmount,
  runSpec,
  validateRun,
  type BrokerParseSpec,
} from "@/lib/broker-spec";
import { FINQALAB_SPEC } from "@/lib/builtin-brokers";
import { SPEC_SCHEMA, specFromDraft, type SpecDraft } from "@/lib/broker-learn";
import { extractStatementText, fingerprintLayout, sampleForLearning } from "@/lib/statement-text";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail?: string) {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

function eq(label: string, actual: unknown, expected: unknown) {
  ok(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function near(label: string, actual: number, expected: number, tol = 0.005) {
  ok(label, Math.abs(actual - expected) <= tol, `got ${actual}, want ${expected} ±${tol}`);
}

function section(name: string) {
  console.log(`\n${name}`);
}

function throws(label: string, fn: () => unknown) {
  try {
    fn();
    ok(label, false, "no error thrown");
  } catch {
    ok(label, true);
  }
}

// ------------------------------------------------------------------- scalars

function checkScalars() {
  section("Amounts and dates");

  eq("thousands separators", parseAmount("1,234.50", "."), 1234.5);
  eq("parentheses mean negative", parseAmount("(42.00)", "."), -42);
  eq("trailing minus means negative", parseAmount("42.00-", "."), -42);
  eq("a currency prefix is ignored", parseAmount("Rs 900", "."), 900);
  eq("European decimals", parseAmount("1.234,50", ","), 1234.5);
  eq("a dash is not a number", parseAmount("-", "."), null);
  eq("neither is a word", parseAmount("N/A", "."), null);

  eq("iso dates", normalizeDate("2026-07-02", "iso"), "2026-07-02");
  eq("day-first dates", normalizeDate("02/07/2026", "dmy"), "2026-07-02");
  eq("month-first dates", normalizeDate("07/02/2026", "mdy"), "2026-07-02");
  eq("two-digit years land this century", normalizeDate("02-07-26", "dmy"), "2026-07-02");
  eq("abbreviated month names", normalizeDate("02-Jul-2026", "monthName"), "2026-07-02");
  eq("month first, spelled out", normalizeDate("July 2, 2026", "monthName"), "2026-07-02");
  eq("the 31st of February is not a date", normalizeDate("31/02/2026", "dmy"), null);
  eq("a day-first date read as month-first is rejected", normalizeDate("31/02/2026", "mdy"), null);
}

// ------------------------------------------------------- built-in Finqalab spec

function checkFinqalab(text: string) {
  section("Finqalab (built-in spec vs. the reference export)");

  const run = runSpec(text, FINQALAB_SPEC);
  const validation = validateRun(run, FINQALAB_SPEC);

  ok("the sample validates", validation.ok, validation.errors.join(" "));
  eq("no line that looks like a trade goes unread", run.unmatched.length, 0);
  eq("no matched row is unusable", run.rowErrors.length, 0);
  ok(
    "the report's own total agrees",
    run.countMatches,
    `stated ${run.totalRecords}, read ${run.trades.length}`,
  );
  ok("the client name is picked up", (run.client ?? "").length > 0);
  ok("the period is picked up", (run.period ?? "").length > 0);

  const csv = readFileSync("data/reference/transactions.csv", "utf8").trim().split(/\r?\n/);
  const header = csv[0].split(",");
  const expected = csv.slice(1).map((line) => {
    const cells = line.split(",");
    return Object.fromEntries(header.map((h, i) => [h, cells[i]])) as Record<string, string>;
  });

  eq("reads every trade in the export", run.trades.length, expected.length);

  // The export is ordered as the report prints it, so compare row by row.
  for (const [i, want] of expected.entries()) {
    const got = run.trades[i];
    if (!got) {
      ok(`row ${i + 1} exists`, false, "missing");
      continue;
    }
    const at = `${want.security} ${want.trade_no}`;
    eq(`${at} security`, got.security, want.security);
    eq(`${at} trade no`, got.tradeNo, want.trade_no);
    eq(`${at} trade date`, got.tradeDate, want.trade_date);
    eq(`${at} settlement date`, got.settlementDate, want.settlement_date);
    eq(`${at} side`, got.side, want.side);
    near(`${at} rate`, got.rate, Number(want.rate));
    eq(`${at} qty`, got.qty, Number(want.qty));
    near(`${at} gross`, got.grossAmount, Number(want.gross_amount));
    near(`${at} brokerage`, got.brokerage, Number(want.brokerage), 0.00005);
    near(`${at} cvt`, got.cvt, Number(want.cvt));
    near(`${at} net`, got.netAmount, Number(want.net_amount));
  }

  // The per-share commission column must stay unmapped: at 0.25% of gross, real
  // brokerage is rupees, not paisa. Reading those two columns the wrong way round
  // would still validate, so pin it here.
  const first = run.trades[0];
  near(
    "brokerage is the total commission, not the per-share one",
    first.brokerage,
    first.grossAmount * 0.0025,
    0.001,
  );

  return run;
}

function checkFingerprint(text: string) {
  section("Finqalab layout fingerprint");

  const fp = fingerprintLayout(text);
  eq("is stable across runs", fingerprintLayout(text), fp);
  eq(
    "survives a different client and period",
    fingerprintLayout(
      text
        .replace(/^Client Name:.*$/m, "Client Name: SOMEONE ELSE")
        .replace(/^Period:.*$/m, "Period: 01-Jan-2027 to 31-Jan-2027"),
    ),
    fp,
  );
  ok(
    "differs for an unrelated report",
    fingerprintLayout("Daily Ledger\nAccount Code\nDate Voucher Debit Credit") !== fp,
  );
}

// ------------------------------------------------------------ validator teeth

function checkValidatorTeeth(text: string, cleanTradeCount: number) {
  section("The validator rejects wrong specs");

  // Rate and quantity read from each other's columns. `gross = rate × qty` can't
  // see this (multiplication commutes) — what gives it away is a fractional
  // "quantity" of shares.
  const swapped: BrokerParseSpec = { ...FINQALAB_SPEC, rateGroup: "qty", qtyGroup: "rate" };
  ok("a rate/qty swap is caught", !validateRun(runSpec(text, swapped), swapped).ok);

  /** A pattern that quietly reads only one symbol — the silent-data-loss spec. */
  const onlyOneSymbol: BrokerParseSpec = {
    ...FINQALAB_SPEC,
    rowPattern: FINQALAB_SPEC.rowPattern.replace("(?<security>[A-Z][A-Z0-9]*)", "(?<security>ATRL)"),
  };
  const partialRun = runSpec(text, onlyOneSymbol);
  ok(
    "dropping rows is caught",
    !validateRun(partialRun, onlyOneSymbol).ok,
    `read ${partialRun.trades.length} of ${cleanTradeCount} and still passed`,
  );

  throws("a spec naming a group that doesn't exist is refused outright", () =>
    runSpec(text, { ...FINQALAB_SPEC, rateGroup: "nosuchcolumn" }),
  );

  // Both of these messages go back to the model verbatim on a retry, and both were
  // written because a vaguer version left qwen3:8b repeating the same mistake.
  try {
    // Using a column heading where a group name belongs — the common confusion.
    runSpec(text, { ...FINQALAB_SPEC, rateGroup: "Rate" });
    ok("the unknown-group error lists the groups that do exist", false, "no error thrown");
  } catch (e) {
    ok(
      "the unknown-group error lists the groups that do exist",
      /defines:.*\brate\b/.test((e as Error).message),
      (e as Error).message,
    );
  }
  throws("a nested quantifier is refused (ReDoS)", () =>
    runSpec(text, {
      ...FINQALAB_SPEC,
      rowPattern: "^(?<security>(?:[A-Z]+)+)\\s+(?<tradeNo>\\d+)\\s+(?<tradeDate>\\S+)$",
    }),
  );
  throws("so is a spec with no named groups at all", () =>
    runSpec(text, { ...FINQALAB_SPEC, rowPattern: "^([A-Z]+) (\\d+)$" }),
  );
}

// ------------------------------------------------- a layout nobody wrote code for

/**
 * Nothing like Finqalab: day-first dates, a B/S code, thousands separators, two fee
 * columns plus a printed net, a subtotal line that looks like a trade row, and a
 * reference column that is blank on most rows.
 */
const OTHER_STATEMENT = `
Sunrise Securities (Pvt) Ltd
Account Title: A. Investor
Statement For: 01/07/2026 - 31/07/2026

Scrip  Ticket   Ref  Trade Dt    Settle Dt   B/S  Qty     Price      Value       Comm      CVT     Net
OGDC   TK-9001       01/07/2026  03/07/2026  B    1,500   212.40     318,600.00  796.50    63.72   319,460.22
LUCK   TK-9002       02/07/2026  04/07/2026  S    200     1,043.75   208,750.00  521.88    0.00    208,228.12
MEBL   TK-9003  R44  03/07/2026  07/07/2026  B    1,000   289.05     289,050.00  722.63    57.81   289,830.44
Sub Total 01/07/2026 - 31/07/2026   2,700   816,400.00  2,041.01  121.53  817,518.78
Total Trades: 3
`.trim();

const OTHER_SPEC: BrokerParseSpec = {
  version: 1,
  broker: "Sunrise Securities",
  rowPattern:
    "^(?<security>[A-Z][A-Z0-9]*)\\s+(?<tradeNo>TK-\\d+)(?:\\s+(?<ref>[A-Z]\\d+))?\\s+(?<tradeDate>\\d{2}/\\d{2}/\\d{4})\\s+(?<settlementDate>\\d{2}/\\d{2}/\\d{4})\\s+(?<sideToken>[BS])\\s+(?<qty>[\\d,]+)\\s+(?<rate>[\\d.,]+)\\s+(?<gross>[\\d.,]+)\\s+(?<comm>[\\d.,]+)\\s+(?<cvt>[\\d.,]+)\\s+(?<net>[\\d.,]+)$",
  dateFormat: "dmy",
  decimalSeparator: ".",
  sideRule: { type: "map", group: "sideToken", map: { B: "BUY", S: "SELL" } },
  qtyGroup: "qty",
  rateGroup: "rate",
  grossGroup: "gross",
  netGroup: "net",
  brokerageGroups: ["comm"],
  cvtGroups: ["cvt"],
  metadata: {
    clientPattern: "^Account Title:\\s*(?<value>.+)$",
    periodPattern: "^Statement For:\\s*(?<value>.+)$",
    totalRecordsPattern: "^Total Trades:\\s*(?<value>\\d+)",
  },
  ignorePatterns: ["^Sub Total\\b"],
};

function checkForeignLayout() {
  section("A foreign layout, read by spec alone");

  const other = runSpec(OTHER_STATEMENT, OTHER_SPEC);
  const validation = validateRun(other, OTHER_SPEC);

  ok("it validates", validation.ok, validation.errors.join(" "));
  eq("reads all three trades", other.trades.length, 3);
  eq("the subtotal row is ignored, not read as a trade", other.unmatched.length, 0);
  eq("day-first dates are normalised", other.trades[0].tradeDate, "2026-07-01");
  eq("B means buy", other.trades[0].side, "BUY");
  eq("S means sell", other.trades[1].side, "SELL");
  eq("thousands separators in quantities", other.trades[0].qty, 1500);
  near("gross survives the commas", other.trades[0].grossAmount, 318600);
  near("a buy's net is above its gross", other.trades[0].netAmount, 319460.22);
  near("a sell's net is below its gross", other.trades[1].netAmount, 208228.12);
  eq(
    "a middle column that's blank on some rows doesn't shift the others",
    other.trades[2].tradeNo,
    "TK-9003",
  );
  eq("the stated total agrees", other.countMatches, true);
  eq("the client name reads", other.client, "A. Investor");
  eq("so does the period", other.period, "01/07/2026 - 31/07/2026");

  /** Dropping the ignore pattern must surface the subtotal line as data loss. */
  const noIgnore: BrokerParseSpec = { ...OTHER_SPEC, ignorePatterns: [] };
  ok(
    "without the ignore pattern, the subtotal is flagged rather than silently skipped",
    !validateRun(runSpec(OTHER_STATEMENT, noIgnore), noIgnore).ok,
  );

  // A printed net is the only independent check on the fee mapping, so exercise it
  // here rather than on Finqalab (which prints no net).
  const wrongFee: BrokerParseSpec = { ...OTHER_SPEC, brokerageGroups: ["gross"] };
  ok(
    "fees mapped to a column that isn't a fee contradict the printed net",
    !validateRun(runSpec(OTHER_STATEMENT, wrongFee), wrongFee).ok,
  );

  // Picking the two-quantity-column rule for a statement that marks the side with a
  // keyword: the error has to name the way out, or a retry just repeats it.
  const wrongSideRule: BrokerParseSpec = {
    ...OTHER_SPEC,
    sideRule: { type: "buySellColumns", buyGroup: "qty", sellGroup: "gross" },
  };
  const wrongSideRun = runSpec(OTHER_STATEMENT, wrongSideRule);
  ok("choosing buy/sell columns for a keyword column fails", !validateRun(wrongSideRun, wrongSideRule).ok);
  ok(
    "…and the failure points at the rule that would work",
    wrongSideRun.rowErrors.some((e) => e.includes("'map'")),
    wrongSideRun.rowErrors[0],
  );

  /** A real-world near-miss: one small charge column left unmapped. */
  const missesCvt: BrokerParseSpec = { ...OTHER_SPEC, cvtGroups: [] };
  const missesCvtValidation = validateRun(runSpec(OTHER_STATEMENT, missesCvt), missesCvt);
  ok("a single unmapped small charge still imports", missesCvtValidation.ok);
  ok("…but it's called out", missesCvtValidation.warnings.length > 0);
}

// -------------------------------------------------- locating a pattern failure

/**
 * The repair loop lives or dies on this: when a pattern misses a row, it has to say
 * *where* it stopped, not just that it stopped. The failing case here is real —
 * qwen3:8b wrote exactly this pattern, whose thousands-separator class matches
 * "1,500" and then can't match "212.40" in the next column.
 */
function checkDiagnosis() {
  section("Locating where a pattern stops matching");

  const row = "OGDC   TK-9001       01/07/2026  03/07/2026  B    1,500   212.40     318,600.00  796.50    63.72   319,460.22";
  const grouped = "\\d{1,3}(?:,\\d{3})*";
  const nearMiss =
    `^\\s*(?<security>\\S+)\\s+(?<tradeNo>\\S+)\\s+(?<tradeDate>\\d{2}/\\d{2}/\\d{4})\\s+` +
    `(?<settlementDate>\\d{2}/\\d{2}/\\d{4})\\s+(?<side>\\w)\\s+(?<qty>${grouped})\\s+(?<price>${grouped})\\s+` +
    `(?<value>${grouped})\\s+(?<comm>${grouped})\\s+(?<cvt>${grouped})\\s+(?<net>${grouped})$`;

  const d = diagnosePattern(nearMiss, row);
  ok("a diagnosis is produced", d !== null);
  eq("names the last group that matched", d?.lastMatched, "qty");
  eq("names the group that failed", d?.failedAt, "price");
  ok("shows the text that beat it", (d?.remainder ?? "").trimStart().startsWith("212.40"));

  const wrongFromTheStart = diagnosePattern(
    "^(?<security>\\d+)\\s+(?<tradeNo>\\S+)$",
    row,
  );
  eq("a pattern that never gets going says so", wrongFromTheStart?.lastMatched, null);
  eq("…and blames its first group", wrongFromTheStart?.failedAt, "security");

  // Cut points must survive nesting, quantifiers, escaped brackets and char classes.
  const gnarly =
    "^(?<security>[A-Z][A-Z0-9]*)\\s+(?<tradeNo>\\d+)(?:\\s+\\d+)?\\s+(?<ref>[\\]\\[(]\\S+)?\\s*(?<tradeDate>\\S+)$";
  const gnarlyDiagnosis = diagnosePattern(gnarly, "HBL 90000101 2026-03-02");
  ok("a pattern with nesting and escapes still diagnoses", gnarlyDiagnosis !== null);
  ok(
    "…and doesn't blame a group that plainly matched",
    gnarlyDiagnosis?.lastMatched === "tradeNo" || gnarlyDiagnosis?.failedAt !== "security",
  );

  eq(
    "a pattern with no named groups can't be diagnosed",
    diagnosePattern("^(\\w+)\\s+(\\d+)$", row),
    null,
  );
  eq("nor can a pattern that matches the line outright", diagnosePattern(OTHER_SPEC.rowPattern, row)?.failedAt, null);
}

// ------------------------------------------------------- the learning contract

/**
 * Everything about learning a parser except the network call: that the response
 * schema stays inside the subset structured outputs accepts, and that a model
 * answer in that shape converts into a spec that actually reads a statement.
 */
function checkLearningContract(finqalabText: string) {
  section("Learning a parser (offline half)");

  // Structured outputs requires additionalProperties:false and an exhaustive
  // `required` on every object, and rejects numeric/length constraints. Getting
  // this wrong is a 400 at the worst possible moment, so assert it here.
  const unsupported = ["minimum", "maximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "pattern"];
  const problems: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const keyword of unsupported) {
      if (keyword in obj) problems.push(`${path} uses unsupported "${keyword}"`);
    }
    if (obj.type === "object") {
      if (obj.additionalProperties !== false) problems.push(`${path} allows additional properties`);
      const properties = Object.keys((obj.properties ?? {}) as object);
      const required = (obj.required ?? []) as string[];
      const missing = properties.filter((p) => !required.includes(p));
      if (missing.length > 0) problems.push(`${path} leaves ${missing.join(", ")} optional`);
    }
    for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`);
  };
  walk(SPEC_SCHEMA, "schema");
  ok("the response schema stays within structured outputs' subset", problems.length === 0, problems.join("; "));

  // A stand-in for what the model returns, in exactly the shape SPEC_SCHEMA
  // describes — the arrays-of-pairs and nulls that `specFromDraft` has to fold.
  const draft: SpecDraft = {
    broker: "Sunrise Securities",
    rowPattern: OTHER_SPEC.rowPattern,
    dateFormat: "dmy",
    decimalSeparator: ".",
    sideRule: {
      type: "map",
      group: "sideToken",
      map: [
        { token: "B", side: "BUY" },
        { token: "S", side: "SELL" },
      ],
      value: null,
      buyGroup: null,
      sellGroup: null,
    },
    qtyGroup: "qty",
    rateGroup: "rate",
    grossGroup: "gross",
    netGroup: "net",
    brokerageGroups: ["comm"],
    cvtGroups: ["cvt"],
    metadata: OTHER_SPEC.metadata,
    ignorePatterns: ["^Sub Total\\b"],
    notes: "Fixed-width columns; the Ref column is often blank.",
  };

  const converted = specFromDraft(draft);
  const run = runSpec(OTHER_STATEMENT, converted);
  ok("a model-shaped answer converts and validates", validateRun(run, converted).ok);
  eq("…and reads the trades", run.trades.length, 3);
  eq("…with the side map folded correctly", run.trades[1].side, "SELL");

  throws("a draft with an empty side map is refused", () =>
    specFromDraft({ ...draft, sideRule: { ...draft.sideRule, map: [] } }),
  );
  throws("a draft naming a column that isn't captured is refused", () =>
    specFromDraft({ ...draft, rateGroup: "priceish" }),
  );

  // The sample is the only thing that leaves the machine. Keep it bounded, and
  // keep the header in it — that's where the column names live.
  const sample = sampleForLearning(finqalabText);
  ok("the learning sample is bounded", sample.length <= 12_000, `${sample.length} chars`);
  ok("…and still contains the header", sample.includes("Client Name:"));
}

async function main() {
  checkScalars();

  const text = await extractStatementText(
    readFileSync("data/sample/finqalab-sample.pdf"),
    "finqalab-sample.pdf",
  );
  const run = checkFinqalab(text);
  checkFingerprint(text);
  checkValidatorTeeth(text, run.trades.length);
  checkForeignLayout();
  checkDiagnosis();
  checkLearningContract(text);

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
