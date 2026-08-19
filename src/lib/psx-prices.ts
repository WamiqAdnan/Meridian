/**
 * The PSX market-watch scrape.
 *
 * Only the fetch-and-parse remains: this module used to own a `PriceCache`
 * table of its own, which was the last PSX-only pricing path in the app. Prices
 * for every market — PSX included — now land in `Quote` via the market pipeline,
 * and `markets/providers/psx.ts` is the one caller of what is left here.
 */
import * as cheerio from "cheerio";

const MARKET_WATCH_URL = "https://dps.psx.com.pk/market-watch";

export interface LivePrice {
  symbol: string;
  price: number; // CURRENT / last traded price
  change: number | null;
  changePct: number | null;
}

function toNum(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw.replace(/,/g, "").replace(/%/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch and parse the PSX market-watch table.
 *
 * The feed is an HTML table whose header cells carry data-name attributes
 * (symbol, sector, listed, ldcp, open, high, low, close, change, percentChange, volume).
 * The live price is the `close` column (labelled CURRENT), NOT `ldcp` (previous close).
 * We map columns by header position so it survives column reordering.
 */
export async function fetchMarketWatch(timeoutMs = 15000): Promise<LivePrice[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let html: string;
  try {
    const res = await fetch(MARKET_WATCH_URL, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`market-watch responded ${res.status}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const $ = cheerio.load(html);

  // Column order from the header's data-name attributes.
  const cols: string[] = [];
  $("thead th").each((_, th) => {
    cols.push($(th).attr("data-name") ?? "");
  });
  const idxSymbol = cols.indexOf("symbol");
  const idxClose = cols.indexOf("close");
  const idxChange = cols.indexOf("change");
  const idxPct = cols.indexOf("percentChange");
  if (idxSymbol < 0 || idxClose < 0) {
    throw new Error("Unexpected market-watch layout (missing symbol/close columns)");
  }

  const cellValue = (tds: cheerio.Cheerio<never>, i: number): string | undefined => {
    if (i < 0) return undefined;
    const td = tds.eq(i);
    return (td.attr("data-order") ?? td.text()).trim();
  };

  const out: LivePrice[] = [];
  $("tbody tr").each((_, tr) => {
    const tds = $(tr).find("td") as unknown as cheerio.Cheerio<never>;
    if (tds.length === 0) return;
    const symCell = tds.eq(idxSymbol);
    const symbol = (
      symCell.find("strong").text() ||
      symCell.attr("data-search") ||
      symCell.text()
    ).trim();
    const price = toNum(cellValue(tds, idxClose));
    if (!symbol || price == null) return;
    out.push({
      symbol,
      price,
      change: toNum(cellValue(tds, idxChange)),
      changePct: toNum(cellValue(tds, idxPct)),
    });
  });

  return out;
}
