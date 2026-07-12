import * as cheerio from "cheerio";
import { prisma } from "./db";

const MARKET_WATCH_URL = "https://dps.psx.com.pk/market-watch";

/**
 * Column positions in the market-watch table:
 *   0 SYMBOL | 1 SECTOR | 2 LISTED IN | 3 LDCP | 4 OPEN | 5 HIGH | 6 LOW |
 *   7 CURRENT | 8 CHANGE | 9 CHANGE (%) | 10 VOLUME
 */
const COL_SYMBOL = 0;
const COL_PRICE = 3;
const COL_CHANGE = 8;
const COL_PCT = 9;

export interface LivePrice {
  symbol: string;
  price: number;
  change: number | null;
  changePct: number | null;
}

function toNum(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = Number(raw.replace(/,/g, "").replace(/%/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/** Fetch and parse the PSX market-watch table. */
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

  const out: LivePrice[] = [];
  $("tbody tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length === 0) return;
    const symCell = tds.eq(COL_SYMBOL);
    const symbol = (
      symCell.find("strong").text() ||
      symCell.attr("data-search") ||
      symCell.text()
    ).trim();
    const price = toNum(tds.eq(COL_PRICE).text());
    if (!symbol || price == null) return;
    out.push({
      symbol,
      price,
      change: toNum(tds.eq(COL_CHANGE).text()),
      changePct: toNum(tds.eq(COL_PCT).text()),
    });
  });

  return out;
}

/**
 * Refresh cached prices. Fetches the whole market and stores only the given
 * symbols (defaults to symbols we currently hold). Returns count updated.
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
