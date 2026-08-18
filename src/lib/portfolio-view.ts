/**
 * Where the portfolio meets the database.
 *
 * The engine in `portfolio.ts` is pure; this is the only place it is handed real
 * rows. It deliberately reuses `markets/view.ts` to load assets rather than
 * querying `Asset`/`Quote`/`PriceBar` again — the portfolio and the market pages
 * must agree on what a price is, and they do so by reading it the same way.
 */
import { prisma } from "./db";
import { loadAssetViews } from "./markets/view";
import { newestFetch } from "./markets/view";
import {
  buildPortfolio,
  DEFAULT_BASE_CURRENCY,
  type Portfolio,
  type PortfolioTrade,
} from "./portfolio";
import { resolveAssetId } from "./ledger";

export interface LoadPortfolioOptions {
  /** A single investor's book, or null/undefined for the combined view. */
  owner?: string | null;
  baseCurrency?: string;
}

export interface LoadedPortfolio extends Portfolio {
  /** Freshest quote timestamp across the assets actually held. */
  pricesFetchedAt: Date | null;
}

export async function loadPortfolio(
  options: LoadPortfolioOptions = {},
): Promise<LoadedPortfolio> {
  const [trades, { assets, fx }] = await Promise.all([
    prisma.transaction.findMany(options.owner ? { where: { owner: options.owner } } : undefined),
    loadAssetViews(),
  ]);

  const portfolio = buildPortfolio(trades as PortfolioTrade[], {
    assets,
    fx,
    baseCurrency: options.baseCurrency ?? DEFAULT_BASE_CURRENCY,
  });

  // Freshness of the prices that back *this* portfolio, not of the whole
  // catalogue — a fresh crypto quote says nothing about a stale PSX holding.
  const heldIds = new Set(portfolio.positions.map((p) => p.assetId));
  const pricesFetchedAt = newestFetch(assets.filter((a) => heldIds.has(a.id)));

  return { ...portfolio, pricesFetchedAt };
}

/** Every asset id the ledger refers to — what the refresh must be able to price. */
export async function heldAssetIds(owner?: string | null): Promise<string[]> {
  const rows = await prisma.transaction.findMany({
    where: owner ? { owner } : undefined,
    select: { security: true, assetId: true },
    distinct: ["security", "assetId"],
  });
  return [...new Set(rows.map(resolveAssetId))];
}
