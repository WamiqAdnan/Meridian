/**
 * Parse a constituents table pasted straight out of the PSX data portal
 * (dps.psx.com.pk → Indices → any index).
 *
 * The published column order is:
 *   SYMBOL | NAME | LDCP | CURRENT | CHANGE | CHANGE (%) | IDX WTG (%) | IDX POINT |
 *   VOLUME | FREEFLOAT (M) | MARKET CAP (M)
 *
 * We take the price from CURRENT and the weight from IDX WTG (%) — never LDCP,
 * which is the previous close.
 *
 * Copy-paste mangles whitespace unpredictably (tabs, runs of spaces, or single
 * spaces), and company names contain spaces of their own, so we don't split on
 * columns. Instead: the first token is the symbol, the last nine tokens are the
 * numbers, and whatever sits in between is the name.
 */

/** A trailing ex-dividend/bonus/rights ticker. PSX lists FFCXD alongside FFC on those days. */
const CORPORATE_ACTION_SUFFIX = /(XD|XB|XR)$/;

/** How many numeric columns the full DPS table carries after SYMBOL and NAME. */
const DPS_NUMERIC_COLUMNS = 9;

export interface ParsedRow {
  /** The ticker exactly as published — what you actually order. */
  symbol: string;
  /** Suffix-stripped ticker, for matching against a ledger that predates the corporate action. */
  baseSymbol: string;
  name: string | null;
  /** The CURRENT column. Null when the row didn't carry a usable price. */
  price: number | null;
  /** IDX WTG (%), e.g. 11.89. Null when the row didn't carry one. */
  weight: number | null;
  /** Previous close, kept only so the UI can show what a missing price would have been. */
  ldcp: number | null;
}

export interface SkippedLine {
  line: string;
  reason: string;
}

export interface ParseResult {
  rows: ParsedRow[];
  skipped: SkippedLine[];
  /** Σ of the parsed raw weights (%) — how much of the index the paste covers. */
  totalWeight: number;
}

/** Parse pasted text into constituents. Unreadable lines are reported, never dropped silently. */
export function parsePsxTable(text: string): ParseResult {
  const rows: ParsedRow[] = [];
  const skipped: SkippedLine[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || isHeader(line)) continue;

    const parsed = parseLine(line);
    if (!parsed) {
      skipped.push({ line: truncate(line), reason: "couldn't read a symbol, price and weight" });
      continue;
    }
    if (seen.has(parsed.symbol)) {
      skipped.push({ line: truncate(line), reason: `${parsed.symbol} appears more than once` });
      continue;
    }
    seen.add(parsed.symbol);
    rows.push(parsed);
  }

  const totalWeight = rows.reduce((s, r) => s + (r.weight ?? 0), 0);
  return { rows, skipped, totalWeight };
}

function parseLine(line: string): ParsedRow | null {
  const tokens = line.split(/\s+/);
  if (tokens.length < 3) return null;

  const symbol = tokens[0].toUpperCase();
  if (!/^[A-Z][A-Z0-9]*$/.test(symbol)) return null;

  const row = (name: string | null, ldcp: number | null, price: number | null, weight: number | null): ParsedRow => ({
    symbol,
    baseSymbol: symbol.replace(CORPORATE_ACTION_SUFFIX, ""),
    name,
    price,
    weight,
    ldcp,
  });

  // Full DPS row: SYMBOL [NAME…] then nine numeric columns. A cell can be blank
  // ("-") on a name that didn't trade — that row still carries a usable weight.
  if (tokens.length >= DPS_NUMERIC_COLUMNS + 1) {
    const tail = tokens.slice(-DPS_NUMERIC_COLUMNS);
    if (tail.every(isCell) && tail.some(isNumeric)) {
      const name = tokens.slice(1, -DPS_NUMERIC_COLUMNS).join(" ") || null;
      return row(name, num(tail[0]), num(tail[1]), num(tail[4]));
    }
  }

  // Hand-typed fallback: SYMBOL price weight.
  if (tokens.length === 3 && isNumeric(tokens[1]) && isNumeric(tokens[2])) {
    return row(null, null, num(tokens[1]), num(tokens[2]));
  }

  return null;
}

/** Skip the header row, however it got pasted. */
function isHeader(line: string): boolean {
  const upper = line.toUpperCase();
  return upper.startsWith("SYMBOL") || upper.includes("IDX WTG");
}

/** "1,234.50", "-0.57%" and "1.82%" are numbers; "-" and "Limited" are not. */
function isNumeric(token: string): boolean {
  return /^-?[\d,]*\.?\d+%?$/.test(token) && /\d/.test(token);
}

/** A numeric column, or an empty cell where PSX prints a dash. */
function isCell(token: string): boolean {
  return isNumeric(token) || token === "-" || token === "—";
}

function num(token: string): number | null {
  const n = Number(token.replace(/,/g, "").replace(/%/g, ""));
  return Number.isFinite(n) ? n : null;
}

function truncate(line: string): string {
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
