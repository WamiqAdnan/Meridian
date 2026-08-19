/**
 * Where the portfolio meets the database.
 *
 * The engine in `portfolio.ts` is pure; this is the only place it is handed real
 * rows. It deliberately reuses `markets/view.ts` to load assets rather than
 * querying `Asset`/`Quote`/`PriceBar` again — the portfolio and the market pages
 * must agree on what a price is, and they do so by reading it the same way.
 */
import { prisma } from "./db";
import { loadAssetViews, type AssetSnapshot } from "./markets/view";
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
  /**
   * Assets and FX the caller has already loaded, reused instead of read again.
   *
   * A page that shows the markets *and* the book would otherwise pay for
   * `loadAssetViews` twice — once here, once for its own cards — and that is
   * ~31k `PriceBar` rows and a full pass of performance maths each time. The
   * overview did exactly that on every render.
   *
   * Sharing one snapshot is not only cheaper. It is the only thing that makes
   * the two halves of such a page *agree*: a refresh landing between two loads
   * would price the cards from one moment and the holdings from another, and
   * nothing on the page would admit it. The module docstring above says the
   * portfolio and the market pages must read a price the same way — this is
   * what makes them read it at the same time as well.
   */
  views?: AssetSnapshot;
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
    options.views ?? loadAssetViews(),
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
