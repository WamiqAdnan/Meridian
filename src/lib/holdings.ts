import type { Side } from "./broker-spec";

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
  warnings: string[];
}

interface Position {
  qty: number;
  grossCost: number; // sum of remaining rate*qty (proportionally reduced on sells)
  fees: number; // remaining fees (proportionally reduced on sells)
  realized: number;
}

/**
 * How close to zero a quantity has to be to count as closed.
 *
 * `Transaction.qty` is a `Float` because a crypto position is not a whole number,
 * and that makes an exact `> 0` test wrong: buying 0.1 and 0.2 gives
 * 0.30000000000000004, so selling 0.3 leaves 4e-17 behind. Without a tolerance
 * that residue is a live holding — a row showing "0.00" units with a cost basis
 * rounded to zero — and the mirror case (buy 0.3, sell 0.1 then 0.2) trips the
 * over-sell warning on a ledger that balances exactly.
 *
 * 1e-9 has an order of magnitude of clearance on both sides: it is far above the
 * ~1e-12 noise fractional quantities actually accumulate, and far below 1e-8, the
 * smallest unit any of these assets is quoted in. Whole-share quantities are exact
 * in binary floating point up to 2^53, so PSX positions never come near it. It is
 * the same threshold `realized` is already tested against below.
 */
const QTY_EPSILON = 1e-9;

/**
 * Replay the whole ledger in chronological order to derive current holdings.
 *
 * - BUY  → increase qty and blend the weighted-average cost (fees included in cost basis).
 * - SELL → book realized P&L = qty*(sellRate - avgCostInclFees) - sellFees, reduce qty,
 *          and scale cost/fees down proportionally so the average cost is preserved.
 * - Any position that reaches qty 0 — within `QTY_EPSILON` — is dropped from `holdings`.
 * - An over-sell (selling more than held, by more than `QTY_EPSILON`) is clamped to
 *   the held qty with a warning.
 */
export function computeHoldings(trades: LedgerTrade[]): HoldingsResult {
  const ordered = [...trades].sort((a, b) =>
    a.tradeDate === b.tradeDate
      ? a.tradeNo.localeCompare(b.tradeNo)
      : a.tradeDate.localeCompare(b.tradeDate),
  );

  const positions = new Map<string, Position>();
  const warnings: string[] = [];

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
      let sellQty = t.qty;
      // Only a sell that overshoots by more than float noise is a real over-sell.
      // Selling exactly what is held can land a hair above it — see QTY_EPSILON —
      // and warning about that would flag a ledger that balances.
      if (sellQty > p.qty + QTY_EPSILON) {
        warnings.push(
          `Over-sell of ${t.security}: sold ${t.qty} but only ${p.qty} held (trade ${t.tradeNo}); clamped.`,
        );
        sellQty = p.qty;
      } else if (sellQty > p.qty) {
        sellQty = p.qty;
      }
      const avgCostInclFees = p.qty > 0 ? (p.grossCost + p.fees) / p.qty : 0;
      p.realized += sellQty * (t.rate - avgCostInclFees) - fees;

      const remaining = p.qty - sellQty;
      const ratio = p.qty > 0 ? remaining / p.qty : 0;
      p.grossCost *= ratio;
      p.fees *= ratio;
      p.qty = remaining;
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
    if (p.qty > QTY_EPSILON) {
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
  return { holdings, realizedBySecurity, realizedTotal: round2(realizedTotal), warnings };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
