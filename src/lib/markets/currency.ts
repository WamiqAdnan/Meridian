/**
 * Money in more than one currency.
 *
 * The existing book is PKR (PSX, settled in rupees); everything added around it
 * is USD or worse. So a portfolio total is meaningless until amounts are stated
 * in one currency, and the rate used has to come from somewhere auditable.
 *
 * It comes from the same place as every other price: FX pairs are ordinary
 * `Asset` rows, quoted by the same providers, refreshed by the same job. There is
 * no separate FX pipeline and no hardcoded rate anywhere in this file.
 *
 * Everything routes through USD as the pivot — with ten majors that is one hop,
 * and it avoids needing a pair for every combination.
 *
 * Pure: build a `FxTable` from quotes, then convert. No Prisma, no fetch.
 */
import { parseAssetId } from "./types";

/** A currency that is not money — an index level or a yield. Never converted. */
export const NOTIONAL_CURRENCIES = new Set(["PTS", "PCT"]);

export function isMoney(currency: string): boolean {
  return !NOTIONAL_CURRENCIES.has(currency.toUpperCase());
}

/** How many USD one unit of each currency buys. USD is always exactly 1. */
export type FxTable = ReadonlyMap<string, number>;

/** The FX inputs: an asset's symbol (e.g. "USDPKR"), its quote currency, and its price. */
export interface FxQuoteInput {
  symbol: string;
  currency: string;
  price: number;
}

/**
 * Build a currency → USD-rate table from whatever FX pairs are priced.
 *
 * A six-letter pair is read as base+quote, and the price is units of quote per
 * one base. Both directions are learned from one pair:
 *   EURUSD @ 1.1574 → 1 EUR = 1.1574 USD
 *   USDPKR @ 277.60 → 1 PKR = 1/277.60 USD
 *
 * Pairs with neither leg in USD are skipped rather than chained, because chaining
 * through a stale second pair produces a rate that looks authoritative and isn't.
 */
export function buildFxTable(quotes: FxQuoteInput[]): FxTable {
  const table = new Map<string, number>([["USD", 1]]);

  for (const q of quotes) {
    if (!Number.isFinite(q.price) || q.price <= 0) continue;
    const symbol = q.symbol.toUpperCase().replace("/", "");
    if (symbol.length !== 6) continue;
    const base = symbol.slice(0, 3);
    const quoteCcy = symbol.slice(3);

    if (quoteCcy === "USD" && base !== "USD") {
      table.set(base, q.price);
    } else if (base === "USD" && quoteCcy !== "USD") {
      table.set(quoteCcy, 1 / q.price);
    }
  }

  return table;
}

/** Build the table straight from asset rows, ignoring anything that isn't an FX pair. */
export function fxTableFromAssets(
  rows: { id: string; symbol: string; currency: string; kind: string; price: number | null }[],
): FxTable {
  return buildFxTable(
    rows
      .filter((r) => r.kind === "fx_pair" && r.price != null && parseAssetId(r.id)?.market === "forex")
      .map((r) => ({ symbol: r.symbol, currency: r.currency, price: r.price! })),
  );
}

/**
 * Convert `amount` from one currency to another.
 *
 * Returns null — never a guess — when either currency is notional or missing from
 * the table. Callers surface that as "insufficient data" rather than dropping the
 * position silently from a total.
 */
export function convert(
  amount: number,
  from: string,
  to: string,
  fx: FxTable,
): number | null {
  const src = from.toUpperCase();
  const dst = to.toUpperCase();
  if (src === dst) return amount;
  if (!isMoney(src) || !isMoney(dst)) return null;

  const srcRate = fx.get(src);
  const dstRate = fx.get(dst);
  if (srcRate == null || dstRate == null || dstRate === 0) return null;

  return (amount * srcRate) / dstRate;
}

/** The rate itself, for display ("1 USD = 277.60 PKR"). */
export function rate(from: string, to: string, fx: FxTable): number | null {
  return convert(1, from, to, fx);
}
