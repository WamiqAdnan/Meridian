/**
 * The refresh job: fetch, persist, record what happened.
 *
 * Two modes, because they cost very different amounts:
 *
 *   quotes    every tracked asset, no history. One batched call for crypto, one
 *             scrape for PSX, one call per Yahoo symbol. Cheap enough to run on
 *             a few-minute cadence.
 *   backfill  quotes plus daily bars. One call per asset everywhere, so it runs
 *             daily — which is exactly as often as a daily close changes.
 *
 * Every run writes a `RefreshRun` row. A provider that starts failing silently is
 * the most likely way this app would show stale numbers while looking healthy, so
 * failures are recorded rather than swallowed.
 */
import { prisma } from "@/lib/db";
import { fetchAssets } from "./registry";
import { listAssets, saveResults, seedCatalogue, syncLedgerAssets } from "./store";
import type { AssetRef, HistoryRange, Market } from "./types";

/** How stale a quote may be before `refreshIfStale` refetches it. */
export const QUOTE_TTL_MS = 5 * 60_000;

export interface RefreshOutcome {
  mode: "quotes" | "backfill";
  assetsRequested: number;
  quotesWritten: number;
  barsWritten: number;
  failures: { assetId: string; error: string }[];
  startedAt: Date;
  finishedAt: Date;
}

export interface RefreshOptions {
  market?: Market;
  ids?: string[];
  /** Daily bars to request. Omit for quote-only. */
  range?: Exclude<HistoryRange, "none">;
}

/**
 * Ensure the catalogue and the ledger's own symbols are present.
 *
 * Cheap and idempotent; called before any refresh so a fresh database becomes
 * usable without a separate setup step.
 */
export async function ensureCatalogue(): Promise<void> {
  await seedCatalogue();
  await syncLedgerAssets();
}

export async function refreshMarketData(options: RefreshOptions = {}): Promise<RefreshOutcome> {
  const startedAt = new Date();
  const mode = options.range ? "backfill" : "quotes";

  await ensureCatalogue();
  const assets = await listAssets({ market: options.market, ids: options.ids });

  const run = await prisma.refreshRun.create({
    data: { source: options.market ? `${mode}:${options.market}` : mode },
  });

  try {
    const results = await fetchAssets(assets, options.range ?? "none");
    const summary = await saveResults(results);
    const finishedAt = new Date();

    await prisma.refreshRun.update({
      where: { id: run.id },
      data: {
        finishedAt,
        assetsOk: summary.quotesWritten,
        assetsFail: summary.failures.length,
        barsWritten: summary.barsWritten,
        // Keep a sample rather than every message; the point is to notice, not to log.
        error:
          summary.failures.length > 0
            ? summary.failures.slice(0, 5).map((f) => `${f.assetId}: ${f.error}`).join(" | ")
            : null,
      },
    });

    return {
      mode,
      assetsRequested: assets.length,
      quotesWritten: summary.quotesWritten,
      barsWritten: summary.barsWritten,
      failures: summary.failures,
      startedAt,
      finishedAt,
    };
  } catch (e) {
    await prisma.refreshRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), error: (e as Error).message },
    });
    throw e;
  }
}

/**
 * Refresh only if the newest quote is older than `maxAgeMs`.
 *
 * Swallows provider failures on purpose — this runs on page render, and a market
 * page showing slightly stale prices beats one that 500s because an upstream
 * blinked. Follows the same contract as the existing `refreshPricesIfStale`.
 */
export async function refreshIfStale(
  options: RefreshOptions & { maxAgeMs?: number } = {},
): Promise<void> {
  const maxAge = options.maxAgeMs ?? QUOTE_TTL_MS;
  try {
    const newest = await prisma.quote.findFirst({
      orderBy: { fetchedAt: "desc" },
      select: { fetchedAt: true },
    });
    if (newest && Date.now() - newest.fetchedAt.getTime() < maxAge) return;
    await refreshMarketData(options);
  } catch {
    // Offline, or an upstream is down. Whatever is cached still renders.
  }
}

/** Assets with no daily bars yet — what a first backfill needs to cover. */
export async function assetsMissingHistory(): Promise<AssetRef[]> {
  const assets = await listAssets();
  const withBars = await prisma.priceBar.groupBy({
    by: ["assetId"],
    _count: { assetId: true },
  });
  const have = new Set(withBars.filter((g) => g._count.assetId > 1).map((g) => g.assetId));
  return assets.filter((a) => !have.has(a.id));
}

export async function lastRefresh(): Promise<{
  source: string;
  finishedAt: Date | null;
  assetsOk: number;
  assetsFail: number;
  error: string | null;
} | null> {
  return prisma.refreshRun.findFirst({
    orderBy: { startedAt: "desc" },
    select: { source: true, finishedAt: true, assetsOk: true, assetsFail: true, error: true },
  });
}
