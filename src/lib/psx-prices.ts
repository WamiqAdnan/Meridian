import * as cheerio from "cheerio";
import { prisma } from "./db";

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

/**
 * Refresh cached prices. Fetches the whole market and stores only the given
 * symbols (defaults to symbols we currently hold). Returns count updated.
 * Never throws for the caller's convenience is NOT assumed — callers should catch.
 */
export async function refreshPrices(symbols?: string[]): Promise<{ updated: number; fetchedAt: Date }> {
  const all = await fetchMarketWatch();
  const wanted = symbols ? new Set(symbols) : null;
  const rows = wanted ? all.filter((p) => wanted.has(p.symbol)) : all;
  const fetchedAt = new Date();

  await prisma.$transaction(
    rows.map((p) =>
      prisma.priceCache.upsert({
        where: { symbol: p.symbol },
        create: {
          symbol: p.symbol,
          lastPrice: p.price,
          change: p.change,
          changePct: p.changePct,
          fetchedAt,
        },
        update: {
          lastPrice: p.price,
          change: p.change,
          changePct: p.changePct,
          fetchedAt,
        },
      }),
    ),
  );

  return { updated: rows.length, fetchedAt };
}

/**
 * Best-effort refresh: fetch fresh prices only if the cache is missing symbols
 * or the newest cached price is older than maxAgeMs. Swallows network errors so
 * the dashboard still renders (holdings-only) when the feed is unreachable.
 */
export async function refreshPricesIfStale(symbols: string[], maxAgeMs = 120_000): Promise<void> {
  if (symbols.length === 0) return;
  const [newest, haveCount] = await Promise.all([
    prisma.priceCache.findFirst({
      where: { symbol: { in: symbols } },
      orderBy: { fetchedAt: "desc" },
      select: { fetchedAt: true },
    }),
    prisma.priceCache.count({ where: { symbol: { in: symbols } } }),
  ]);
  const fresh = newest && Date.now() - newest.fetchedAt.getTime() < maxAgeMs;
  if (fresh && haveCount >= symbols.length) return;
  try {
    await refreshPrices(symbols);
  } catch {
    // offline / feed down — leave whatever is cached, dashboard degrades gracefully
  }
}

/** Read cached prices for the given symbols as a lookup map. */
export async function getCachedPrices(symbols: string[]): Promise<Map<string, { price: number; change: number | null; changePct: number | null; fetchedAt: Date }>> {
  const rows = await prisma.priceCache.findMany({ where: { symbol: { in: symbols } } });
  const map = new Map<string, { price: number; change: number | null; changePct: number | null; fetchedAt: Date }>();
  for (const r of rows) {
    map.set(r.symbol, { price: r.lastPrice, change: r.change, changePct: r.changePct, fetchedAt: r.fetchedAt });
  }
  return map;
}
