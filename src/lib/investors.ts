/**
 * The people sharing the single Finqalab account. Each ledger row is tagged with
 * one of these `owner`s so holdings can be viewed per-person or combined ("Together").
 *
 * To add/rename an investor, edit this list — everything else (upload selector,
 * dashboard switcher, transactions filter) derives from it.
 */
export const INVESTORS = ["Investor A", "Investor B"] as const;
export type Investor = (typeof INVESTORS)[number];

export function isInvestor(v: unknown): v is Investor {
  return typeof v === "string" && (INVESTORS as readonly string[]).includes(v);
}

/** Normalize an untrusted query value into a valid owner, or `null` for the combined view. */
export function toOwnerFilter(v: unknown): Investor | null {
  return isInvestor(v) ? v : null;
}
