import * as cheerio from "cheerio";

/**
 * Fetch an index's constituents — symbol, current price and published index weight —
 * from the PSX data portal.
 *
 * The portal's Indices page loads each index's table over XHR from
 * /indices/{CODE}, which returns an HTML fragment (not JSON). Its columns are:
 *   SYMBOL | NAME | LDCP | CURRENT | CHANGE | CHANGE (%) | IDX WTG (%) | IDX POINT |
 *   VOLUME | FREEFLOAT (M) | MARKET CAP (M)
 *
 * Unlike the market-watch feed, these header cells carry no data-name attributes,
 * so columns are located by header text and the layout can be reordered without
 * breaking us. We read the price from CURRENT — never LDCP, the previous close.
 */

const INDICES_URL = "https://dps.psx.com.pk/indices";

/** Cache window. Weights barely move intraday; prices do, so keep it short. */
const CACHE_TTL_MS = 60_000;

/** A trailing ex-dividend/bonus/rights ticker — PSX lists FFCXD in place of FFC on those days. */
const CORPORATE_ACTION_SUFFIX = /(XD|XB|XR)$/;

/**
 * The indices worth replicating, with the portal's own naming. Every code is
 * verified against /indices/{CODE}. This is also the allow-list that keeps a
 * request parameter from reaching the upstream URL.
 */
export const INDEX_OPTIONS = [
  { code: "KSE100", label: "KSE 100", size: 100 },
  { code: "KSE30", label: "KSE 30", size: 30 },
  { code: "KMI30", label: "KMI 30 (Shariah)", size: 30 },
  { code: "PSXDIV20", label: "PSX Dividend 20", size: 20 },
  { code: "MII30", label: "Mahaana Islamic 30", size: 30 },
  { code: "BKTI", label: "Banking (BKTi)", size: 8 },
  { code: "OGTI", label: "Oil & Gas (OGTi)", size: 3 },
  { code: "ALLSHR", label: "KSE All Share", size: 552 },
  { code: "KMIALLSHR", label: "KMI All Share", size: 310 },
] as const;

export type IndexCode = (typeof INDEX_OPTIONS)[number]["code"];

export const DEFAULT_INDEX: IndexCode = "KSE30";

export function isIndexCode(v: unknown): v is IndexCode {
  return typeof v === "string" && INDEX_OPTIONS.some((o) => o.code === v);
}

export interface IndexConstituent {
  /** The ticker as published — what you actually order. */
  symbol: string;
  /** Suffix-stripped ticker, for matching a ledger that predates a corporate action. */
  baseSymbol: string;
  name: string | null;
  /** The CURRENT column. */
  price: number | null;
  /** IDX WTG (%), e.g. 11.89. */
  weight: number | null;
}

export interface IndexSnapshot {
  code: IndexCode;
  rows: IndexConstituent[];
  /** Σ of the published weights (%) — a healthy index sums to ~100. */
  totalWeight: number;
  fetchedAt: string; // ISO, so it can cross the server/client boundary
}

const cache = new Map<IndexCode, IndexSnapshot>();

/** Fetch an index, reusing a snapshot newer than CACHE_TTL_MS. */
export async function getIndexConstituents(
  code: IndexCode,
  timeoutMs = 15000,
): Promise<IndexSnapshot> {
  const cached = cache.get(code);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < CACHE_TTL_MS) return cached;

  const snapshot = await fetchIndexConstituents(code, timeoutMs);
  cache.set(code, snapshot);
  return snapshot;
}

/** Fetch and parse one index's constituents table, bypassing the cache. */
export async function fetchIndexConstituents(
  code: IndexCode,
  timeoutMs = 15000,
): Promise<IndexSnapshot> {
  if (!isIndexCode(code)) throw new Error(`Unknown index code: ${code}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let html: string;
  try {
    const res = await fetch(`${INDICES_URL}/${code}`, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/html",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`PSX responded ${res.status}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const rows = parseConstituentsTable(html);
  if (rows.length === 0) throw new Error(`No constituents found for ${code}`);

  return {
    code,
    rows,
    totalWeight: rows.reduce((s, r) => s + (r.weight ?? 0), 0),
    fetchedAt: new Date().toISOString(),
  };
}

/** Exported for the check script — parsing the fragment shouldn't need the network. */
export function parseConstituentsTable(html: string): IndexConstituent[] {
  const $ = cheerio.load(html);

  const headers: string[] = [];
  $("thead th").each((_, th) => {
    headers.push(normalizeHeader($(th).text()));
  });
  const idxSymbol = headers.indexOf("SYMBOL");
  const idxName = headers.indexOf("NAME");
  const idxPrice = headers.indexOf("CURRENT");
  const idxWeight = headers.findIndex((h) => h.startsWith("IDX WTG"));
  if (idxSymbol < 0 || idxPrice < 0 || idxWeight < 0) {
    throw new Error("Unexpected constituents layout (missing SYMBOL, CURRENT or IDX WTG columns)");
  }

  const out: IndexConstituent[] = [];
  $("tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length === 0) return;

    // Prefer each cell's sortable data-order attribute; fall back to rendered text.
    const cell = (i: number): string => {
      const td = tds.eq(i);
      return (td.attr("data-order") ?? td.text()).trim();
    };

    const symCell = tds.eq(idxSymbol);
    const symbol = (symCell.attr("data-order") || symCell.find("strong").text() || symCell.text())
      .trim()
      .toUpperCase();
    if (!symbol) return;

    out.push({
      symbol,
      baseSymbol: symbol.replace(CORPORATE_ACTION_SUFFIX, ""),
      name: idxName >= 0 ? tds.eq(idxName).text().trim() || null : null,
      price: toNumber(cell(idxPrice)),
      weight: toNumber(cell(idxWeight)),
    });
  });

  return out;
}

/** Collapse whitespace so "IDX WTG (%)" matches however the portal spaces it. */
function normalizeHeader(text: string): string {
  return text.replace(/\s+/g, " ").trim().toUpperCase();
}

/** "1,234.50" and "11.89%" become numbers; a blank or "-" cell becomes null. */
function toNumber(raw: string): number | null {
  if (!raw || !/\d/.test(raw)) return null;
  const n = Number(raw.replace(/,/g, "").replace(/%/g, ""));
  return Number.isFinite(n) ? n : null;
}
