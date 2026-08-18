/**
 * Where market data meets the database.
 *
 * Every Prisma call for market data lives here, so the engines above
 * (`performance.ts`, `currency.ts`) stay pure and testable and the providers stay
 * ignorant of storage. The rule from the brief holds throughout: market data is
 * external and disposable, the ledger is the user's — this module writes to
 * `Asset`/`Quote`/`PriceBar` and reads `Transaction`, never the reverse.
 */
import { prisma } from "@/lib/db";
import { resolveAssetId } from "@/lib/ledger";
import { CATALOGUE } from "./catalogue";
import {
  assetId,
  isMarket,
  parseAssetId,
  type AssetRef,
  type BarData,
  type Market,
  type ProviderQuoteResult,
  type QuoteData,
} from "./types";

/** An asset row with its latest quote, which is what nearly every page wants. */
export interface AssetWithQuote extends AssetRef {
  price: number | null;
  previousClose: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  quoteSource: string | null;
  fetchedAt: Date | null;
  marketTime: Date | null;
}

type AssetRow = {
  id: string;
  market: string;
  symbol: string;
  name: string;
  kind: string;
  currency: string;
  source: string;
  sourceSymbol: string;
  rank: number;
  benchmark: boolean;
};

function toRef(row: AssetRow): AssetRef {
  return {
    id: row.id,
    market: row.market as Market,
    symbol: row.symbol,
    name: row.name,
    kind: row.kind as AssetRef["kind"],
    currency: row.currency,
    source: row.source,
    sourceSymbol: row.sourceSymbol,
    rank: row.rank,
    benchmark: row.benchmark,
  };
}

/* ----------------------------------------------------------------- seeding */

/**
 * Write the seed catalogue into `Asset`.
 *
 * Idempotent, and safe to run on every boot. Updates the descriptive columns (a
 * renamed instrument, a corrected provider symbol) but never `active`, so an
 * asset the user has switched off stays off across restarts.
 */
export async function seedCatalogue(): Promise<{ seeded: number }> {
  // This runs before every refresh, including one triggered by a page render.
  // Once the catalogue is fully present there is nothing to write, so skip the
  // ~90 upserts rather than repeat them on each stale page load.
  const present = await prisma.asset.count({ where: { id: { in: CATALOGUE.map((a) => a.id) } } });
  if (present === CATALOGUE.length) return { seeded: 0 };

  for (const a of CATALOGUE) {
    await prisma.asset.upsert({
      where: { id: a.id },
      create: {
        id: a.id,
        market: a.market,
        symbol: a.symbol,
        name: a.name,
        kind: a.kind,
        currency: a.currency,
        source: a.source,
        sourceSymbol: a.sourceSymbol,
        rank: a.rank,
        benchmark: true,
      },
      update: {
        name: a.name,
        kind: a.kind,
        currency: a.currency,
        source: a.source,
        sourceSymbol: a.sourceSymbol,
        rank: a.rank,
        benchmark: true,
      },
    });
  }
  return { seeded: CATALOGUE.length };
}

/**
 * Make sure everything in the ledger has an `Asset` to price against.
 *
 * The ledger predates markets, so its rows carry a bare `security` string and no
 * `assetId`. Those are PSX equities by definition — that is the only thing the
 * importer could ever have produced — so they resolve to `psx:{security}` and the
 * `assetId` column is backfilled in place. Nothing about the ledger's own numbers
 * is touched.
 *
 * **The market comes from `resolveAssetId`, never from `security` alone.** A
 * hand-entered trade stores a bare ticker in `security` too — `buildManualTrade`
 * writes `security: "BTC"` beside `assetId: "crypto:BTC"` — so reading the market
 * off `security` invented a `psx:BTC` equity for every non-PSX position: a
 * phantom row in the PSX listing and the movers table, a guaranteed failure on
 * every refresh (market-watch has never heard of it, and `yahooSymbolFor`
 * declines anything in the `psx` market, so no fallback exists), and a duplicate
 * hit in the search box.
 *
 * A row that resolves to some *other* market is left alone rather than guessed
 * at. Only `psx` can be reconstructed from a ticker — the currency and the
 * provider follow from the market — and a holding with no `Asset` behind it is
 * already reported: `buildPortfolio` shows it at cost and names it in a warning.
 */
export async function syncLedgerAssets(): Promise<{ created: number; linked: number }> {
  const rows = await prisma.transaction.findMany({
    select: { security: true, assetId: true },
    distinct: ["security", "assetId"],
  });

  // Two ledger rows can resolve to one asset (a backfilled row and a fresh one),
  // so resolve first and dedupe on the id rather than on the pair. The symbol is
  // read back out of the id rather than off `security`, so the row it creates
  // cannot disagree with its own key — and rebuilding through `assetId` uppercases
  // it, so a hand-written `psx:ffc` does not become a second row beside `psx:FFC`.
  const psxSymbols = new Map<string, string>();
  for (const row of rows) {
    const parsed = parseAssetId(resolveAssetId(row));
    if (parsed?.market !== "psx") continue;
    const symbol = parsed.symbol.toUpperCase();
    psxSymbols.set(assetId("psx", symbol), symbol);
  }

  // One query rather than one per symbol: this runs before every refresh,
  // including one triggered by a page render.
  const present = new Set(
    (
      await prisma.asset.findMany({
        where: { id: { in: [...psxSymbols.keys()] } },
        select: { id: true },
      })
    ).map((a) => a.id),
  );

  let created = 0;
  for (const [id, symbol] of psxSymbols) {
    if (present.has(id)) continue;
    await prisma.asset.create({
      data: {
        id,
        market: "psx",
        symbol,
        name: symbol,
        kind: "stock",
        currency: "PKR",
        source: "psx",
        sourceSymbol: symbol,
        rank: 100,
        // Held, not seeded — it belongs in the movers table but not in the
        // "here is the PSX market" summary.
        benchmark: false,
      },
    });
    created++;
  }

  const linked = await prisma.$executeRaw`
    UPDATE "Transaction"
       SET "assetId" = 'psx:' || UPPER("security")
     WHERE "assetId" IS NULL`;

  return { created, linked };
}

/* ----------------------------------------------------------------- reading */

export interface AssetFilter {
  market?: Market;
  /** Only assets seeded as part of the market overview. */
  benchmarkOnly?: boolean;
  ids?: string[];
  includeInactive?: boolean;
}

export async function listAssets(filter: AssetFilter = {}): Promise<AssetRef[]> {
  const rows = await prisma.asset.findMany({
    where: {
      ...(filter.includeInactive ? {} : { active: true }),
      ...(filter.market ? { market: filter.market } : {}),
      ...(filter.benchmarkOnly ? { benchmark: true } : {}),
      ...(filter.ids ? { id: { in: filter.ids } } : {}),
    },
    orderBy: [{ rank: "asc" }, { symbol: "asc" }],
  });
  return rows.map(toRef);
}

export async function listAssetsWithQuotes(filter: AssetFilter = {}): Promise<AssetWithQuote[]> {
  const rows = await prisma.asset.findMany({
    where: {
      ...(filter.includeInactive ? {} : { active: true }),
      ...(filter.market ? { market: filter.market } : {}),
      ...(filter.benchmarkOnly ? { benchmark: true } : {}),
      ...(filter.ids ? { id: { in: filter.ids } } : {}),
    },
    orderBy: [{ rank: "asc" }, { symbol: "asc" }],
    include: { quote: true },
  });

  return rows.map((row) => ({
    ...toRef(row),
    price: row.quote?.price ?? null,
    previousClose: row.quote?.previousClose ?? null,
    change: row.quote?.change ?? null,
    changePct: row.quote?.changePct ?? null,
    volume: row.quote?.volume ?? null,
    quoteSource: row.quote?.source ?? null,
    fetchedAt: row.quote?.fetchedAt ?? null,
    marketTime: row.quote?.marketTime ?? null,
  }));
}

export async function getAsset(id: string): Promise<AssetWithQuote | null> {
  const [row] = await listAssetsWithQuotes({ ids: [id], includeInactive: true });
  return row ?? null;
}

/**
 * Daily bars for many assets at once, each series sorted oldest-first —
 * the shape `computePerformance` expects.
 */
export async function loadBars(
  assetIds: string[],
  sinceDate?: string,
): Promise<Map<string, BarData[]>> {
  if (assetIds.length === 0) return new Map();
  const rows = await prisma.priceBar.findMany({
    where: {
      assetId: { in: assetIds },
      ...(sinceDate ? { date: { gte: sinceDate } } : {}),
    },
    orderBy: [{ assetId: "asc" }, { date: "asc" }],
  });

  const out = new Map<string, BarData[]>();
  for (const r of rows) {
    const bar: BarData = {
      assetId: r.assetId,
      date: r.date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      source: r.source,
    };
    const bucket = out.get(r.assetId);
    if (bucket) bucket.push(bar);
    else out.set(r.assetId, [bar]);
  }
  return out;
}

/** yyyy-mm-dd `days` before today, in UTC. */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/* ----------------------------------------------------------------- writing */

async function saveQuote(q: QuoteData): Promise<void> {
  const data = {
    price: q.price,
    previousClose: q.previousClose,
    change: q.change,
    changePct: q.changePct,
    dayHigh: q.dayHigh,
    dayLow: q.dayLow,
    volume: q.volume,
    marketTime: q.marketTime,
    source: q.source,
    fetchedAt: new Date(),
  };
  await prisma.quote.upsert({
    where: { assetId: q.assetId },
    create: { assetId: q.assetId, ...data },
    update: data,
  });
}

/**
 * Persist bars, overwriting any existing row for the same (asset, date).
 *
 * Overwrite rather than skip: today's bar is written repeatedly as the session
 * runs, and each write should carry the newer close.
 */
async function saveBars(bars: BarData[]): Promise<number> {
  if (bars.length === 0) return 0;
  const CHUNK = 200;
  let written = 0;
  for (let i = 0; i < bars.length; i += CHUNK) {
    const chunk = bars.slice(i, i + CHUNK);
    await prisma.$transaction(
      chunk.map((b) =>
        prisma.priceBar.upsert({
          where: { assetId_date: { assetId: b.assetId, date: b.date } },
          create: { ...b },
          update: { open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, source: b.source },
        }),
      ),
    );
    written += chunk.length;
  }
  return written;
}

export interface SaveSummary {
  quotesWritten: number;
  barsWritten: number;
  failures: { assetId: string; error: string }[];
}

/** Write a batch of provider results. Assets that failed are reported, not thrown. */
export async function saveResults(results: ProviderQuoteResult[]): Promise<SaveSummary> {
  const summary: SaveSummary = { quotesWritten: 0, barsWritten: 0, failures: [] };
  const allBars: BarData[] = [];

  for (const r of results) {
    // Record any reported error, including a partial one where the quote came
    // through but history did not. Only counting total failures once hid an
    // entire provider being rate-limited, because every coin still had a price.
    if (r.error) {
      summary.failures.push({ assetId: r.assetId, error: r.error });
    }
    if (r.quote) {
      await saveQuote(r.quote);
      summary.quotesWritten++;
    }
    allBars.push(...r.bars);
  }

  summary.barsWritten = await saveBars(allBars);
  return summary;
}

/** Normalize an untrusted `?market=` value. */
export function toMarketFilter(v: unknown): Market | null {
  return isMarket(v) ? v : null;
}
