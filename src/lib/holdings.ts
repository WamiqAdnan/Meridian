import type { Side } from "./finqalab-parser";

/** Minimal shape the engine needs — satisfied by both ParsedTrade and DB rows. */
export interface LedgerTrade {
  security: string;
  tradeNo: string;
  tradeDate: string;
  side: Side | string;
  rate: number;
  qty: number;
  brokerage: number;
  cvt: number;
}

export interface Holding {
  security: string;
  qty: number;
  avgRate: number; // weighted-average execution price (excl. fees)
  fees: number; // total fees baked into the remaining position
  totalCost: number; // grossCost + fees
  avgCostInclFees: number; // totalCost / qty — the true break-even price
}

export interface HoldingsResult {
  holdings: Holding[]; // only positions with qty > 0, sorted by security
  realizedBySecurity: Record<string, number>; // realized P&L booked from SELLs
  realizedTotal: number;
}

interface Position {
  qty: number;
  grossCost: number;
  fees: number;
  realized: number;
}

/**
 * Replay the whole ledger in chronological order to derive current holdings.
 *
 * - BUY  → increase qty and blend the weighted-average cost (fees included in cost basis).
 * - SELL → book realized P&L = qty*(sellRate - avgCostInclFees) - sellFees, and reduce
 *          the position.
 * - Any position that reaches qty 0 is dropped from `holdings`.
 */
export function computeHoldings(trades: LedgerTrade[]): HoldingsResult {
  const ordered = [...trades].sort((a, b) =>
    a.tradeDate === b.tradeDate
      ? a.tradeNo.localeCompare(b.tradeNo)
      : a.tradeDate.localeCompare(b.tradeDate),
  );

  const positions = new Map<string, Position>();

  for (const t of ordered) {
    let p = positions.get(t.security);
    if (!p) {
      p = { qty: 0, grossCost: 0, fees: 0, realized: 0 };
      positions.set(t.security, p);
    }
    const fees = t.brokerage + t.cvt;

    if (t.side === "BUY") {
      p.qty += t.qty;
      p.grossCost += t.rate * t.qty;
      p.fees += fees;
    } else {
      // SELL
      const avgCostInclFees = p.qty > 0 ? (p.grossCost + p.fees) / p.qty : 0;
      p.realized += t.qty * (t.rate - avgCostInclFees) - fees;
      p.qty -= t.qty;
      p.grossCost -= t.rate * t.qty;
      p.fees -= fees;
    }
  }

  const holdings: Holding[] = [];
  const realizedBySecurity: Record<string, number> = {};
  let realizedTotal = 0;

  for (const [security, p] of positions) {
    if (Math.abs(p.realized) > 1e-9) {
      realizedBySecurity[security] = round2(p.realized);
      realizedTotal += p.realized;
    }
    if (p.qty > 0) {
      const totalCost = p.grossCost + p.fees;
      holdings.push({
        security,
        qty: p.qty,
        avgRate: p.grossCost / p.qty,
        fees: round2(p.fees),
        totalCost: round2(totalCost),
        avgCostInclFees: totalCost / p.qty,
      });
    }
  }

  holdings.sort((a, b) => a.security.localeCompare(b.security));
  return { holdings, realizedBySecurity, realizedTotal: round2(realizedTotal) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
