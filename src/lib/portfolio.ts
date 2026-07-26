import { prisma } from "./db";
import { computeHoldings, type Holding } from "./holdings";
import { getCachedPrices } from "./psx-prices";

export interface HoldingWithPrice extends Holding {
  livePrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  dayChangePct: number | null;
}

export interface PortfolioTotals {
  invested: number; // sum of totalCost across holdings
  marketValue: number; // sum of market value (only for priced holdings)
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedTotal: number;
  positions: number;
}

export interface Portfolio {
  holdings: HoldingWithPrice[];
  totals: PortfolioTotals;
  realizedBySecurity: Record<string, number>;
  warnings: string[];
  pricesFetchedAt: Date | null;
  pricedCount: number;
}

/**
 * Build the full portfolio view from the ledger + cached prices.
 * Pass an `owner` to view a single investor; omit (or null) for the combined view.
 */
export async function getPortfolio(owner?: string | null): Promise<Portfolio> {
  const trades = await prisma.transaction.findMany(owner ? { where: { owner } } : undefined);
  const { holdings, realizedBySecurity, realizedTotal, warnings } = computeHoldings(trades);

  const prices = await getCachedPrices(holdings.map((h) => h.security));
  let pricesFetchedAt: Date | null = null;
  let pricedCount = 0;

  const enriched: HoldingWithPrice[] = holdings.map((h) => {
    const p = prices.get(h.security);
    if (!p) {
      return {
        ...h,
        livePrice: null,
        marketValue: null,
        unrealizedPnl: null,
        unrealizedPnlPct: null,
        dayChangePct: null,
      };
    }
    pricedCount++;
    if (!pricesFetchedAt || p.fetchedAt > pricesFetchedAt) pricesFetchedAt = p.fetchedAt;
    const marketValue = p.price * h.qty;
    const unrealizedPnl = marketValue - h.totalCost;
    return {
      ...h,
      livePrice: p.price,
      marketValue,
      unrealizedPnl,
      unrealizedPnlPct: h.totalCost > 0 ? (unrealizedPnl / h.totalCost) * 100 : 0,
      dayChangePct: p.changePct,
    };
  });

  const invested = enriched.reduce((s, h) => s + h.totalCost, 0);
  // Market value falls back to cost for unpriced holdings so totals stay sensible.
  const marketValue = enriched.reduce((s, h) => s + (h.marketValue ?? h.totalCost), 0);
  const unrealizedPnl = marketValue - invested;

  return {
    holdings: enriched,
    totals: {
      invested,
      marketValue,
      unrealizedPnl,
      unrealizedPnlPct: invested > 0 ? (unrealizedPnl / invested) * 100 : 0,
      realizedTotal,
      positions: enriched.length,
    },
    realizedBySecurity,
    warnings,
    pricesFetchedAt,
    pricedCount,
  };
}
