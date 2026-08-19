/**
 * The people sharing the single broker account. Each ledger row is tagged with
 * one of these `owner`s so holdings can be viewed per-person or combined ("Together").
 *
 * Real names are not checked in. This repository is public, and who shares an
 * account is not the repository's business — so the list is configuration, and
 * an unconfigured checkout gets the placeholders below.
 *
 *   NEXT_PUBLIC_INVESTORS="Ada,Grace"
 *
 * `NEXT_PUBLIC_` is not decoration: the owner selects, the ledger table and the
 * add-trade form are client components, and a server-only variable reads as
 * `undefined` in the browser bundle. Next inlines it at build time, so a change
 * needs a restart rather than a reload.
 *
 * **Renaming an investor does not rename their trades.** These strings are what
 * `Transaction.owner` holds, and `isInvestor` is the allow-list every write is
 * checked against — so dropping a name orphans that person's rows: they stay in
 * the database, and stop appearing under anyone. Migrate the column in the same
 * breath as the variable.
 */

/** What an unconfigured checkout shows. Deliberately nobody. */
const FALLBACK_INVESTORS = ["Investor A", "Investor B"] as const;

function configuredInvestors(): readonly string[] {
  const names = (process.env.NEXT_PUBLIC_INVESTORS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  // De-duplicated: two identical names would render as two indistinguishable
  // options that write the same owner.
  const unique = [...new Set(names)];
  return unique.length > 0 ? unique : FALLBACK_INVESTORS;
}

export const INVESTORS: readonly string[] = configuredInvestors();

/**
 * Once a literal union built from a fixed tuple; `string` now that the list is
 * configuration. Nothing imports the type — `isInvestor` is the guard the app
 * actually leans on, and it still narrows against the configured list at
 * runtime, which is what was protecting `Transaction.owner` all along.
 */
export type Investor = string;

export function isInvestor(v: unknown): v is Investor {
  return typeof v === "string" && INVESTORS.includes(v);
}

/** Normalize an untrusted query value into a valid owner, or `null` for the combined view. */
export function toOwnerFilter(v: unknown): Investor | null {
  return isInvestor(v) ? v : null;
}
