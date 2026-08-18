/**
 * A broker statement parser, expressed as data rather than code.
 *
 * Every broker prints the same handful of facts (symbol, dates, side, rate, qty,
 * fees) in a different column order with a different date format, so a parser is
 * really just: one regex that recognises a trade row, plus a mapping from its
 * named capture groups onto our ledger fields. That is small enough to be
 * generated once by an LLM (see `broker-learn.ts`), stored in the database, and
 * replayed deterministically forever after — no model call on the happy path.
 *
 * Specs are *declarative on purpose*: nothing here is eval'd, so a spec from the
 * model can only ever pick columns and formats, never run logic.
 */

export type Side = "BUY" | "SELL";

export interface ParsedTrade {
  security: string;
  tradeNo: string;
  tradeDate: string; // yyyy-mm-dd
  settlementDate: string; // yyyy-mm-dd
  side: Side;
  rate: number; // execution price per share
  qty: number;
  grossAmount: number; // rate * qty
  brokerage: number; // total broker commission for the trade
  cvt: number;
  netAmount: number; // BUY: gross + fees, SELL: gross - fees
}

/** How the broker writes dates. `monthName` covers "02-Jul-2026" and "Jul 2, 2026" alike. */
export type DateFormat = "iso" | "dmy" | "mdy" | "monthName";

export type SideRule =
  /** A column holds the side keyword; `map` translates the broker's wording. */
  | { type: "map"; group: string; map: Record<string, Side> }
  /** The report only ever contains one side (e.g. a purchases-only statement). */
  | { type: "fixed"; value: Side }
  /** Quantity is signed: negative means a sale. */
  | { type: "signedQty" }
  /** Separate buy-qty and sell-qty columns; whichever is non-zero wins. */
  | { type: "buySellColumns"; buyGroup: string; sellGroup: string };

export interface BrokerParseSpec {
  version: 1;
  /** Display name of the broker this spec reads, e.g. "Finqalab". */
  broker: string;
  /** Regex with named groups, matched against each trimmed line of the statement. */
  rowPattern: string;
  dateFormat: DateFormat;
  decimalSeparator: "." | ",";
  sideRule: SideRule;
  /** Group holding the traded quantity. Unused (and ignorable) for `buySellColumns`. */
  qtyGroup: string | null;
  rateGroup: string;
  /** Gross consideration. Derived from rate * qty when the report omits it. */
  grossGroup: string | null;
  /** Net settled amount. Derived from gross ± fees when the report omits it. */
  netGroup: string | null;
  /** Groups summed into `brokerage` — commission, plus any fee without its own column. */
  brokerageGroups: string[];
  /** Groups summed into `cvt` (capital value tax). */
  cvtGroups: string[];
  /** Optional single-capture regexes for the report header. */
  metadata: {
    clientPattern: string | null;
    periodPattern: string | null;
    totalRecordsPattern: string | null;
  };
  /**
   * Lines to skip before the "did we silently drop a trade row?" check runs —
   * subtotal and carry-forward rows that happen to look like trades.
   */
  ignorePatterns: string[];
  /** Free-text note from whoever (or whatever) wrote the spec. */
  notes?: string;
}

export interface SpecRunResult {
  trades: ParsedTrade[];
  client: string | null;
  period: string | null;
  totalRecords: number | null; // the "Total Records" figure printed in the report
  countMatches: boolean; // does trades.length match totalRecords?
  /** Rows that matched the pattern but produced unusable values. */
  rowErrors: string[];
  /** Lines that look like trade rows but the pattern didn't match — i.e. dropped data. */
  unmatched: string[];
}

const MAX_LINE_LEN = 2000;

/* ------------------------------------------------------------------ scalars */

function stripAmount(raw: string, decimalSeparator: "." | ","): string {
  let s = raw.trim().replace(/[\s ]/g, "");
  s = s.replace(/^(?:rs\.?|pkr|₨|\$)/i, "");
  let negative = false;
  if (/^\((.*)\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (decimalSeparator === ",") s = s.replace(/\./g, "").replace(/,/g, ".");
  else s = s.replace(/,/g, "");
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  return negative ? `-${s}` : s;
}

/** Parse a broker-formatted amount ("1,234.50", "(42.00)", "Rs 900"). `null` if unreadable. */
export function parseAmount(raw: string | undefined, decimalSeparator: "." | ","): number | null {
  if (raw === undefined) return null;
  const s = stripAmount(raw, decimalSeparator);
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function assemble(y: number, m: number, d: number): string | null {
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  // Reject impossible days (31 Feb) by round-tripping through Date.
  const probe = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/** Normalize a broker-formatted date to yyyy-mm-dd. `null` if it isn't a date in `fmt`. */
export function normalizeDate(raw: string | undefined, fmt: DateFormat): string | null {
  if (raw === undefined) return null;
  const s = raw.trim();

  if (fmt === "monthName") {
    const parts = s.split(/[\s,\-/.]+/).filter(Boolean);
    if (parts.length !== 3) return null;
    const monthPart = parts.find((p) => /^[A-Za-z]+$/.test(p));
    if (!monthPart) return null;
    const month = MONTHS[monthPart.slice(0, 3).toLowerCase()];
    if (!month) return null;
    const numbers = parts.filter((p) => p !== monthPart);
    const yearPart = numbers.find((p) => p.length === 4) ?? numbers[1];
    const dayPart = numbers.find((p) => p !== yearPart);
    if (!yearPart || !dayPart) return null;
    return assemble(Number(yearPart), month, Number(dayPart));
  }

  const m = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/.exec(s);
  if (!m) return null;
  const [, a, b, c] = m;
  if (fmt === "iso") return assemble(Number(a), Number(b), Number(c));
  if (fmt === "dmy") return assemble(Number(c), Number(b), Number(a));
  return assemble(Number(c), Number(a), Number(b)); // mdy
}

/* -------------------------------------------------------------- spec safety */

/**
 * Compile a spec-supplied pattern. Rejects nested quantifiers — the shape behind
 * catastrophic backtracking — because a spec can come from an LLM rather than us.
 */
export function compilePattern(pattern: string, label: string): RegExp {
  if (pattern.length > 4000) throw new Error(`${label} is implausibly long`);
  if (/\((?:\?:)?[^()]*[+*][^()]*\)\s*[+*{]/.test(pattern)) {
    throw new Error(`${label} nests quantifiers, which risks catastrophic backtracking`);
  }
  try {
    return new RegExp(pattern);
  } catch (e) {
    throw new Error(`${label} is not a valid regex: ${(e as Error).message}`);
  }
}

/**
 * Cut points in a pattern, one just after each top-level named group closes, so a
 * prefix of the pattern can be compiled on its own. Tracks escapes and character
 * classes, since a `]` or `)` inside either doesn't close anything.
 */
function namedGroupCuts(pattern: string): { name: string; end: number }[] {
  const cuts: { name: string; end: number }[] = [];
  const open: { name: string | null; depth: number }[] = [];
  let depth = 0;
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      const named = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(pattern.slice(i));
      depth++;
      open.push({ name: named ? named[1] : null, depth });
      continue;
    }
    if (c === ")") {
      const group = open.pop();
      depth--;
      // Only groups at the top level give a prefix that stands alone.
      if (group?.name && group.depth === 1) {
        // Include a following quantifier so the prefix means what it meant inside.
        let end = i + 1;
        if ("?*+".includes(pattern[end] ?? "")) end++;
        cuts.push({ name: group.name, end });
      }
    }
  }
  return cuts;
}

export interface PatternDiagnosis {
  /** The last named group that matched, or null if the pattern fails immediately. */
  lastMatched: string | null;
  /** The group that then failed, or null if the pattern matched further than any group. */
  failedAt: string | null;
  /** What the pattern consumed before failing. */
  consumed: string;
  /** The rest of the line — where the answer usually is. */
  remainder: string;
}

/**
 * Work out how far a row pattern gets through a line before failing, by compiling
 * successively longer prefixes of it.
 *
 * "This line didn't match" is nearly useless feedback for repairing a pattern;
 * "it matched through `qty` and then failed at `price`, where the line reads
 * 212.40" is actionable, whether the reader is a person or a model.
 */
export function diagnosePattern(pattern: string, line: string): PatternDiagnosis | null {
  const cuts = namedGroupCuts(pattern);
  if (cuts.length === 0) return null;

  let best: { name: string; matched: string } | null = null;
  let failedAt: string | null = null;

  for (const cut of cuts) {
    const prefix = pattern.slice(0, cut.end).replace(/\$$/, "");
    let re: RegExp;
    try {
      re = new RegExp(prefix);
    } catch {
      continue; // an incomplete alternation or backreference; skip this cut
    }
    const m = re.exec(line);
    if (m && m.index === 0) {
      // A group that swallows only part of its column counts as a failure, not a
      // success: `\d{1,3}(?:,\d{3})*` matches the "212" of "212.40" quite happily,
      // and the pattern then dies on the whitespace that was supposed to follow.
      // Only enforce this where the pattern really does expect a gap next.
      const expectsGap = /^(?:\\s|[ \t])/.test(pattern.slice(cut.end));
      const nextChar = line[m[0].length];
      if (!expectsGap || nextChar === undefined || /\s/.test(nextChar)) {
        best = { name: cut.name, matched: m[0] };
        continue;
      }
    }
    failedAt = cut.name;
    break;
  }

  const consumed = best?.matched ?? "";
  return {
    lastMatched: best?.name ?? null,
    failedAt,
    consumed,
    remainder: line.slice(consumed.length),
  };
}

const SIDE_TYPES = ["map", "fixed", "signedQty", "buySellColumns"] as const;
const DATE_FORMATS: DateFormat[] = ["iso", "dmy", "mdy", "monthName"];

/**
 * Structural check on an untrusted spec: field types, referenced groups exist in
 * the row pattern, every pattern compiles. Throws on the first problem found.
 */
export function assertValidSpec(spec: BrokerParseSpec): void {
  if (spec.version !== 1) throw new Error("Unsupported spec version");
  if (!spec.broker?.trim()) throw new Error("Spec is missing a broker name");
  if (!DATE_FORMATS.includes(spec.dateFormat)) throw new Error(`Unknown dateFormat: ${spec.dateFormat}`);
  if (spec.decimalSeparator !== "." && spec.decimalSeparator !== ",") {
    throw new Error("decimalSeparator must be '.' or ','");
  }

  compilePattern(spec.rowPattern, "rowPattern");
  const groups = new Set(
    [...spec.rowPattern.matchAll(/\(\?<([A-Za-z_$][\w$]*)>/g)].map((m) => m[1]),
  );
  if (groups.size === 0) throw new Error("rowPattern has no named capture groups");

  const need = (name: string | null | undefined, field: string) => {
    if (!name) throw new Error(`Spec is missing ${field}`);
    if (!groups.has(name)) {
      // Name the groups that do exist: the usual cause is a column heading from the
      // statement being used where a capture-group name belongs.
      throw new Error(
        `${field} refers to unknown group "${name}". The pattern defines: ${[...groups].join(", ")}.`,
      );
    }
  };
  const optional = (name: string | null | undefined, field: string) => {
    if (name) need(name, field);
  };

  // The ledger can't do without these three; settlement date falls back to trade date.
  for (const required of ["security", "tradeNo", "tradeDate"]) {
    if (!groups.has(required)) throw new Error(`rowPattern has no "${required}" group`);
  }
  need(spec.rateGroup, "rateGroup");
  optional(spec.qtyGroup, "qtyGroup");
  optional(spec.grossGroup, "grossGroup");
  optional(spec.netGroup, "netGroup");

  for (const g of [...(spec.brokerageGroups ?? []), ...(spec.cvtGroups ?? [])]) need(g, "a fee group");

  const rule = spec.sideRule;
  if (!rule || !SIDE_TYPES.includes(rule.type)) throw new Error("sideRule has an unknown type");
  if (rule.type === "map") {
    need(rule.group, "sideRule.group");
    const entries = Object.entries(rule.map ?? {});
    if (entries.length === 0) throw new Error("sideRule.map is empty");
    for (const [, v] of entries) {
      if (v !== "BUY" && v !== "SELL") throw new Error(`sideRule.map value must be BUY or SELL, got "${v}"`);
    }
  } else if (rule.type === "fixed") {
    if (rule.value !== "BUY" && rule.value !== "SELL") throw new Error("sideRule.value must be BUY or SELL");
  } else if (rule.type === "buySellColumns") {
    need(rule.buyGroup, "sideRule.buyGroup");
    need(rule.sellGroup, "sideRule.sellGroup");
  } else if (!spec.qtyGroup) {
    throw new Error("sideRule 'signedQty' needs a qtyGroup");
  }

  if (rule.type !== "buySellColumns" && !spec.qtyGroup) throw new Error("Spec is missing qtyGroup");

  for (const [key, p] of Object.entries(spec.metadata ?? {})) {
    if (p) compilePattern(p, `metadata.${key}`);
  }
  for (const p of spec.ignorePatterns ?? []) compilePattern(p, "ignorePatterns entry");
}

/* ------------------------------------------------------------------ the run */

const DATE_TOKEN =
  /\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}[-\s][A-Za-z]{3,9}[-\s]\d{2,4}/g;

/**
 * Does this line carry a date and enough figures to plausibly be a trade row?
 *
 * Used only to notice rows a spec *should* have read — a false positive costs a
 * spurious rejection, so the bar is a date plus four numbers that aren't part of
 * one. The dates have to come out before counting: "Period: 01/07/2026 to
 * 03/07/2026" is six numbers and two dates, and is not a trade.
 */
function looksLikeTradeRow(line: string): boolean {
  // `replace` rather than `test`: a /g regex carries lastIndex between test calls.
  const withoutDates = line.replace(DATE_TOKEN, " ");
  if (withoutDates === line) return false; // no date at all
  const numbers = withoutDates.match(/\d[\d,]*(?:\.\d+)?/g);
  return (numbers?.length ?? 0) >= 4;
}

function firstCapture(re: RegExp, line: string): string | null {
  const m = re.exec(line);
  if (!m) return null;
  return (m.groups?.value ?? m[1] ?? m[0]).trim() || null;
}

function resolveSide(
  spec: BrokerParseSpec,
  groups: Record<string, string | undefined>,
): { side: Side; qty: number } | string {
  const dec = spec.decimalSeparator;
  const rule = spec.sideRule;

  if (rule.type === "buySellColumns") {
    const buy = parseAmount(groups[rule.buyGroup], dec) ?? 0;
    const sell = parseAmount(groups[rule.sellGroup], dec) ?? 0;
    // Say what the rule assumed and what it found: the usual cause is this rule
    // being chosen for a statement that marks the side with a keyword instead.
    const columns = `${rule.buyGroup}="${groups[rule.buyGroup] ?? ""}" and ${rule.sellGroup}="${groups[rule.sellGroup] ?? ""}"`;
    if (buy > 0 && sell > 0) {
      return `sideRule 'buySellColumns' needs one of its two quantity columns to be empty on each row, but ${columns} both hold values. If a single column marks the side with a keyword or letter, use sideRule type 'map' on that column instead`;
    }
    if (buy > 0) return { side: "BUY", qty: buy };
    if (sell > 0) return { side: "SELL", qty: sell };
    return `sideRule 'buySellColumns' found no quantity in either column (${columns})`;
  }

  const rawQty = parseAmount(groups[spec.qtyGroup!], dec);
  if (rawQty === null) return `unreadable quantity "${groups[spec.qtyGroup!] ?? ""}"`;

  if (rule.type === "signedQty") {
    if (rawQty === 0) return "row has a zero quantity";
    return { side: rawQty < 0 ? "SELL" : "BUY", qty: Math.abs(rawQty) };
  }
  if (rule.type === "fixed") return { side: rule.value, qty: Math.abs(rawQty) };

  const token = (groups[rule.group] ?? "").trim();
  const hit =
    rule.map[token] ??
    rule.map[token.toUpperCase()] ??
    Object.entries(rule.map).find(([k]) => k.toLowerCase() === token.toLowerCase())?.[1];
  if (!hit) return `unrecognised side "${token}"`;
  return { side: hit, qty: Math.abs(rawQty) };
}

/**
 * Apply a spec to extracted statement text. Never throws on bad *data* — bad rows
 * land in `rowErrors` and dropped-looking lines in `unmatched`, so `validateRun`
 * can decide whether the spec is trustworthy. Throws only on an invalid spec.
 */
export function runSpec(text: string, spec: BrokerParseSpec): SpecRunResult {
  assertValidSpec(spec);

  const row = compilePattern(spec.rowPattern, "rowPattern");
  const clientRe = spec.metadata.clientPattern
    ? compilePattern(spec.metadata.clientPattern, "metadata.clientPattern")
    : null;
  const periodRe = spec.metadata.periodPattern
    ? compilePattern(spec.metadata.periodPattern, "metadata.periodPattern")
    : null;
  const totalRe = spec.metadata.totalRecordsPattern
    ? compilePattern(spec.metadata.totalRecordsPattern, "metadata.totalRecordsPattern")
    : null;
  const ignoreRes = (spec.ignorePatterns ?? []).map((p) => compilePattern(p, "ignorePatterns entry"));

  const dec = spec.decimalSeparator;
  const trades: ParsedTrade[] = [];
  const rowErrors: string[] = [];
  const unmatched: string[] = [];
  let client: string | null = null;
  let period: string | null = null;
  let totalRecords: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > MAX_LINE_LEN) continue;

    const m = row.exec(line);
    if (!m) {
      if (client === null && clientRe) client = firstCapture(clientRe, line);
      if (period === null && periodRe) period = firstCapture(periodRe, line);
      if (totalRecords === null && totalRe) {
        const v = firstCapture(totalRe, line);
        if (v !== null) {
          const n = parseInt(v.replace(/[^\d]/g, ""), 10);
          totalRecords = Number.isNaN(n) ? null : n;
        }
      }
      if (looksLikeTradeRow(line) && !ignoreRes.some((re) => re.test(line))) unmatched.push(line);
      continue;
    }

    const g = m.groups ?? {};
    const security = (g.security ?? "").trim().toUpperCase();
    const tradeNo = (g.tradeNo ?? "").trim();
    const tradeDate = normalizeDate(g.tradeDate, spec.dateFormat);
    const settlementDate = g.settlementDate
      ? normalizeDate(g.settlementDate, spec.dateFormat)
      : tradeDate;
    const rate = parseAmount(g[spec.rateGroup], dec);
    const sided = resolveSide(spec, g);

    const problems: string[] = [];
    if (!security) problems.push("missing security");
    if (!tradeNo) problems.push("missing trade number");
    if (!tradeDate) problems.push(`unreadable trade date "${g.tradeDate ?? ""}"`);
    if (!settlementDate) problems.push(`unreadable settlement date "${g.settlementDate ?? ""}"`);
    if (rate === null || rate <= 0) problems.push(`unreadable rate "${g[spec.rateGroup] ?? ""}"`);
    if (typeof sided === "string") problems.push(sided);
    if (problems.length > 0) {
      rowErrors.push(`${problems.join("; ")} — in: ${line.slice(0, 160)}`);
      continue;
    }

    const { side, qty } = sided as { side: Side; qty: number };
    const sum = (names: string[]) =>
      names.reduce((total, name) => total + (parseAmount(g[name], dec) ?? 0), 0);
    const brokerage = sum(spec.brokerageGroups ?? []);
    const cvt = sum(spec.cvtGroups ?? []);
    const fees = brokerage + cvt;
    const grossFromColumn = spec.grossGroup ? parseAmount(g[spec.grossGroup], dec) : null;
    const grossAmount = grossFromColumn === null ? rate! * qty : Math.abs(grossFromColumn);
    const netFromColumn = spec.netGroup ? parseAmount(g[spec.netGroup], dec) : null;
    const netAmount =
      netFromColumn === null
        ? side === "BUY"
          ? grossAmount + fees
          : grossAmount - fees
        : Math.abs(netFromColumn);

    trades.push({
      security,
      tradeNo,
      tradeDate: tradeDate!,
      settlementDate: settlementDate!,
      side,
      rate: rate!,
      qty,
      grossAmount,
      brokerage,
      cvt,
      netAmount,
    });
  }

  return {
    trades,
    client,
    period,
    totalRecords,
    countMatches: totalRecords === null ? true : totalRecords === trades.length,
    rowErrors,
    unmatched,
  };
}

export interface SpecValidation {
  ok: boolean;
  /** Reasons the spec cannot be trusted with this document. */
  errors: string[];
  /** Surprising but survivable observations, surfaced to the user. */
  warnings: string[];
}

/**
 * Decide whether a run is trustworthy enough to write to the ledger.
 *
 * This is the gate that makes an LLM-authored spec safe to keep: the arithmetic
 * has to close, the count has to match the report's own total, and no line that
 * looks like a trade may go unread. A spec that passes here has been checked
 * against the whole document, not just the sample the model saw.
 */
export function validateRun(result: SpecRunResult, spec: BrokerParseSpec): SpecValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (result.trades.length === 0) errors.push("No trade rows matched.");
  if (result.rowErrors.length > 0) {
    errors.push(
      `${result.rowErrors.length} matched row(s) had unusable values. First: ${result.rowErrors[0]}`,
    );
  }
  if (result.unmatched.length > 0) {
    errors.push(
      `${result.unmatched.length} line(s) look like trade rows but were not read. First: ${result.unmatched[0].slice(0, 160)}`,
    );
  }
  if (!result.countMatches) {
    errors.push(
      `Read ${result.trades.length} trades but the report states ${result.totalRecords}.`,
    );
  }

  const seen = new Set<string>();
  for (const t of result.trades) {
    if (seen.has(t.tradeNo)) {
      errors.push(`Duplicate trade number ${t.tradeNo} within one report — is that column really unique?`);
      break;
    }
    seen.add(t.tradeNo);
  }

  for (const t of result.trades) {
    // Shares trade whole, and the ledger's qty column is an integer. A fractional
    // quantity means a column is mapped to the wrong field — most often rate and
    // qty swapped, which the gross check below cannot see (rate × qty commutes).
    if (!Number.isInteger(t.qty)) {
      errors.push(
        `${t.security} ${t.tradeDate}: quantity ${t.qty} isn't a whole number of shares — the quantity column looks misidentified.`,
      );
      break;
    }
    if (t.settlementDate < t.tradeDate) {
      errors.push(
        `${t.security} settles (${t.settlementDate}) before it trades (${t.tradeDate}) — the date columns look swapped.`,
      );
      break;
    }
  }

  if (spec.grossGroup) {
    for (const t of result.trades) {
      const expected = t.rate * t.qty;
      const tolerance = Math.max(1, expected * 0.01);
      if (Math.abs(t.grossAmount - expected) > tolerance) {
        errors.push(
          `${t.security} ${t.tradeDate}: gross ${t.grossAmount.toFixed(2)} ≠ rate × qty (${expected.toFixed(2)}) — a column is mapped to the wrong field.`,
        );
        break;
      }
    }
  }

  // When the broker prints a net, it's an independent check on the fee mapping.
  // A small gap means a minor charge we don't read (a tax on commission, say) and
  // is worth mentioning; a large one means a column is mapped to the wrong field.
  if (spec.netGroup) {
    for (const t of result.trades) {
      const fees = t.brokerage + t.cvt;
      const expected = t.side === "BUY" ? t.grossAmount + fees : t.grossAmount - fees;
      const gap = Math.abs(t.netAmount - expected);
      if (gap > Math.max(2, t.grossAmount * 0.005)) {
        errors.push(
          `${t.security} ${t.tradeDate}: net ${t.netAmount.toFixed(2)} is nowhere near gross ± the fees read (${expected.toFixed(2)}) — a column is mapped to the wrong field.`,
        );
        break;
      }
      // Fees run to tenths of a percent of gross, so the bar for "we're missing a
      // charge" has to be far tighter than the bar for "wrong column" above —
      // anything past rounding noise is worth saying out loud.
      if (gap > Math.max(0.5, t.grossAmount * 0.0001)) {
        warnings.push(
          `${t.security} ${t.tradeDate}: net is off by ${gap.toFixed(2)} from gross ± the fees read — there may be a charge column we're not picking up.`,
        );
        break;
      }
    }
  }

  if ((spec.brokerageGroups ?? []).length === 0) {
    warnings.push("This parser reads no brokerage column, so cost basis excludes commission.");
  }

  return { ok: errors.length === 0, errors, warnings };
}
