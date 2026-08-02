/**
 * Index replicator — turn a basket of index constituents plus a fixed amount of
 * cash into an exact, buyable list of whole shares that matches the index weights.
 *
 * Pure arithmetic: no Prisma, no fetch, no `window`. That keeps it importable from
 * the client component (so results recompute as you type) and from a plain Node
 * check script.
 *
 * This is allocation math, NOT advice — nothing here says whether, when, or what
 * to buy, only how to split a chosen amount across a chosen basket.
 */

/**
 * Broker charges, all overridable — these defaults follow one Pakistani broker's
 * Schedule of Charges and will differ from yours.
 *
 * Not modelled (they aren't charged at buy time): CDC custody (0.005625%/month on
 * holding value), annual NCCPL UIN/KYC renewal, and on a later sell, commission
 * again plus slab-based capital-gains tax.
 */
export interface FeeSchedule {
  commissionPct: number; // % of trade value, when price >= priceThreshold
  smallPerShare: number; // per-share commission instead, when price < priceThreshold
  priceThreshold: number; // boundary between the two commission modes
  cdcTxnPct: number; // CDC transaction fee, % of trade value
  cdcTxnMin: number; // CDC transaction fee floor, per trade — dominates small trades
  setupOneTime: number; // charged once, new accounts only
  setupAnnual: number; // charged annually, new accounts only
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  commissionPct: 0.25,
  smallPerShare: 0.03,
  priceThreshold: 12,
  cdcTxnPct: 0.0036,
  cdcTxnMin: 5,
  setupOneTime: 523.15,
  setupAnnual: 400,
};

export interface Constituent {
  /** Symbol as it will be ordered — keep the raw ticker (e.g. FFCXD on an ex-dividend day). */
  symbol: string;
  /** Current/last traded price. Never the previous close (LDCP). */
  price: number;
  /** The raw published index weight (%), e.g. 11.89. The subset normally sums to < 100. */
  weight: number;
  name?: string | null;
  /** True when `price` was reused from an earlier quote rather than the pasted table. */
  stalePrice?: boolean;
}

export interface ReplicationInput {
  amount: number;
  constituents: Constituent[];
  isNewAccount?: boolean;
  feeSchedule?: FeeSchedule;
  /**
   * Reserved for the buy-only rebalance extension (weight the tranche against
   * what you already own). Ignored today — each tranche is weighted in isolation.
   */
  holdings?: { symbol: string; shares: number }[];
}

export interface PlanRow {
  symbol: string;
  name: string | null;
  /** Weight rescaled so the selected subset sums to exactly 1. */
  normWeight: number;
  price: number;
  /** normWeight * amount — the ideal spend before whole-share rounding. */
  target: number;
  shares: number;
  cost: number;
  stalePrice: boolean;
}

export interface FeeBreakdown {
  commission: number;
  cdcTxn: number;
  setup: number;
  total: number;
}

export interface ReplicationPlan {
  ok: true;
  rows: PlanRow[];
  buyList: { symbol: string; shares: number }[];
  invested: number;
  fees: FeeBreakdown;
  grandTotal: number;
  /** Cash left over after whole-share rounding and fees. Never negative. */
  buffer: number;
  tradeCount: number;
  /** Σ of the raw published weights of the selected subset (%) — how much of the index this covers. */
  totalRawWeight: number;
  warnings: string[];
}

export interface ReplicationError {
  ok: false;
  error: string;
}

export type ReplicationResult = ReplicationPlan | ReplicationError;

/** Commission for one trade (§5): a % of value, or per-share for penny stocks. */
export function tradeCommission(
  cost: number,
  price: number,
  shares: number,
  f: FeeSchedule,
): number {
  return price >= f.priceThreshold
    ? (cost * f.commissionPct) / 100
    : shares * f.smallPerShare;
}

/** CDC transaction fee for one trade — a % of value with a per-trade floor. */
export function tradeCdcFee(cost: number, f: FeeSchedule): number {
  return Math.max((cost * f.cdcTxnPct) / 100, f.cdcTxnMin);
}

/**
 * Weight `amount` across `constituents` in proportion to their index weights,
 * in whole shares, with every fee accounted for.
 *
 * Shares are always floored — rounding up would overspend, and the exchange only
 * trades whole shares. Weights are always normalized: using the raw weights would
 * silently leave the missing percentage of the amount uninvested.
 */
export function planReplication(input: ReplicationInput): ReplicationResult {
  const f = input.feeSchedule ?? DEFAULT_FEE_SCHEDULE;
  const { amount, constituents } = input;

  if (!Number.isFinite(amount) || amount <= 0) return fail("Enter an amount greater than 0.");
  if (constituents.length === 0) return fail("Tick at least one symbol.");
  for (const c of constituents) {
    if (!Number.isFinite(c.price) || c.price <= 0) {
      return fail(`${c.symbol} has no usable price — fix that row or untick it.`);
    }
    if (!Number.isFinite(c.weight) || c.weight < 0) {
      return fail(`${c.symbol} has an invalid index weight.`);
    }
  }

  const totalRawWeight = constituents.reduce((s, c) => s + c.weight, 0);
  if (totalRawWeight <= 0) {
    return fail("The ticked symbols carry no index weight between them.");
  }

  const setup = input.isNewAccount ? f.setupOneTime + f.setupAnnual : 0;
  if (setup >= amount) {
    return fail(
      `New-account fees (${rs(setup)}) use up the whole amount — nothing would be left to invest.`,
    );
  }

  const rows: PlanRow[] = constituents.map((c) => {
    const normWeight = c.weight / totalRawWeight;
    const target = amount * normWeight;
    const shares = Math.floor(target / c.price);
    return {
      symbol: c.symbol,
      name: c.name ?? null,
      normWeight,
      price: c.price,
      target,
      shares,
      cost: shares * c.price,
      stalePrice: c.stalePrice === true,
    };
  });

  // Shares are floored, so no row can overshoot its own target — but the fees sit
  // on top of the full amount, so the grand total still can. Shave single shares
  // off the least-damaging position until it fits. Fees shrink as shares go, so
  // they are re-tallied every pass.
  const trimmed: string[] = [];
  let fees = tallyFees(rows, setup, f);
  let guard = rows.reduce((s, r) => s + r.shares, 0) + 1;
  while (invested(rows) + fees.total > amount && guard-- > 0) {
    const shortfall = invested(rows) + fees.total - amount;
    const victim = pickVictim(rows, shortfall);
    if (!victim) break;
    victim.shares -= 1;
    victim.cost = victim.shares * victim.price;
    trimmed.push(victim.symbol);
    fees = tallyFees(rows, setup, f);
  }

  const investedTotal = invested(rows);
  const grandTotal = investedTotal + fees.total;
  if (grandTotal - amount > 1e-9) {
    return fail(
      `${rs(amount)} can't cover the fees on this basket — the ${rs(f.cdcTxnMin)} per-trade CDC minimum alone comes to ${rs(f.cdcTxnMin * rows.length)} across ${rows.length} names.`,
    );
  }

  const tradeCount = rows.filter((r) => r.shares > 0).length;
  const warnings = buildWarnings(rows, investedTotal, fees, tradeCount, trimmed);

  return {
    ok: true,
    rows,
    buyList: rows.filter((r) => r.shares > 0).map((r) => ({ symbol: r.symbol, shares: r.shares })),
    invested: round2(investedTotal),
    fees: {
      commission: round2(fees.commission),
      cdcTxn: round2(fees.cdcTxn),
      setup: round2(fees.setup),
      total: round2(fees.total),
    },
    grandTotal: round2(grandTotal),
    buffer: round2(amount - grandTotal),
    tradeCount,
    totalRawWeight,
    warnings,
  };
}

/** Fees for the whole plan. Only rows that actually trade are charged. */
function tallyFees(rows: PlanRow[], setup: number, f: FeeSchedule): FeeBreakdown {
  let commission = 0;
  let cdcTxn = 0;
  for (const r of rows) {
    if (r.shares <= 0) continue;
    commission += tradeCommission(r.cost, r.price, r.shares, f);
    cdcTxn += tradeCdcFee(r.cost, f);
  }
  return { commission, cdcTxn, setup, total: commission + cdcTxn + setup };
}

function invested(rows: PlanRow[]): number {
  return rows.reduce((s, r) => s + r.cost, 0);
}

/**
 * The share to give up. Prefer a position whose price alone closes the shortfall
 * (so one pass is usually enough), and among those the one where a single share is
 * the smallest slice of its own target — that's the least tracking damage.
 */
function pickVictim(rows: PlanRow[], shortfall: number): PlanRow | null {
  const holders = rows.filter((r) => r.shares > 0);
  if (holders.length === 0) return null;
  const covering = holders.filter((r) => r.price >= shortfall);
  const pool = covering.length > 0 ? covering : holders;
  return pool.reduce((best, r) => (damage(r) < damage(best) ? r : best));
}

/** What fraction of its target one share of this row represents. */
function damage(r: PlanRow): number {
  return r.target > 0 ? r.price / r.target : Number.POSITIVE_INFINITY;
}

function buildWarnings(
  rows: PlanRow[],
  investedTotal: number,
  fees: FeeBreakdown,
  tradeCount: number,
  trimmed: string[],
): string[] {
  const warnings: string[] = [];
  const zeros = rows.filter((r) => r.shares === 0);

  if (investedTotal === 0) {
    warnings.push(
      "Nothing is buyable at this amount — every name rounds down to 0 shares. Raise the amount or cut the basket down to the heaviest few weights.",
    );
  } else if (zeros.length > 0) {
    warnings.push(
      `${zeros.map((r) => r.symbol).join(", ")} rounded to 0 shares — too expensive for ${zeros.length === 1 ? "its" : "their"} weight at this amount. ${zeros.length === 1 ? "It is" : "They are"} still counted in the weighting.`,
    );
  }

  // Names priced far above their per-weight budget can never round cleanly, no
  // matter how the rest of the basket is arranged. Reported as one line — at small
  // amounts this is true of most of the basket, and 12 near-identical warnings
  // bury everything else.
  const coarse = rows
    .filter((r) => r.shares > 0 && damage(r) >= 0.2)
    .sort((a, b) => damage(b) - damage(a));
  if (coarse.length > 0) {
    const worst = coarse
      .slice(0, 3)
      .map(
        (r) =>
          `${r.symbol} (${r.shares} share${r.shares === 1 ? "" : "s"}, one share is ${Math.round(damage(r) * 100)}% of its ${rs(r.target)} target)`,
      );
    const more = coarse.length > 3 ? `, and ${coarse.length - 3} more` : "";
    warnings.push(
      `Coarse fit: ${worst.join("; ")}${more}. The share price is large next to the budget that weight allows, so it can't round cleanly — a larger amount narrows the gap.`,
    );
  }

  // Fidelity is about trading friction, so the one-off account setup is excluded —
  // it says nothing about how well this basket tracks.
  const tradingFees = fees.commission + fees.cdcTxn;
  const feeRatio = investedTotal > 0 ? tradingFees / investedTotal : Infinity;
  if (investedTotal > 0 && (feeRatio > 0.005 || zeros.length > 0)) {
    warnings.push(
      `Low replication fidelity: trading fees are ${(feeRatio * 100).toFixed(2)}% of the amount invested across ${tradeCount} trade${tradeCount === 1 ? "" : "s"}. A concentrated basket of the top 3–4 weights tracks better at this size.`,
    );
  }

  const stale = rows.filter((r) => r.stalePrice);
  if (stale.length > 0) {
    warnings.push(
      `Prices marked * (${stale.map((r) => r.symbol).join(", ")}) were reused from an earlier quote, not the pasted table — re-check them before ordering.`,
    );
  }

  if (trimmed.length > 0) {
    warnings.push(
      `Trimmed one share of ${[...new Set(trimmed)].join(", ")} so the fees fit inside the amount.`,
    );
  }

  return warnings;
}

function fail(error: string): ReplicationError {
  return { ok: false, error };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Plain "Rs 1,234.50" for warning text — the UI formatters live in format.ts. */
function rs(n: number): string {
  return `Rs ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
