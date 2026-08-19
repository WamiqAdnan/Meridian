/**
 * Helpers every provider needs. Kept here rather than in whichever provider
 * happened to define one first, so no provider has to import a sibling.
 *
 * Pure — no fetch, no Prisma — so the check script exercises all of it directly.
 */
import type { BarData, QuoteData } from "../types";

/** A number, or null for NaN/Infinity/undefined. The only numeric guard providers use. */
export function finite(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * Run `work` over `items` at most `limit` at a time, preserving input order.
 *
 * Providers fetch one symbol per request, and a full refresh is ~90 symbols;
 * unbounded `Promise.all` would look like an attack, and a serial loop is slow.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * Derive a quote from the two newest daily bars.
 *
 * The fallback for any feed that publishes closes but no live tick — PSX index
 * levels and ECB reference rates both land here.
 */
export function quoteFromBars(
  assetId: string,
  bars: BarData[],
  source: string,
): QuoteData | null {
  const last = bars.at(-1);
  if (!last) return null;
  const prev = bars.at(-2)?.close ?? null;
  const change = prev != null ? last.close - prev : null;
  return {
    assetId,
    price: last.close,
    previousClose: prev,
    change,
    changePct: prev != null && prev !== 0 ? (change! / prev) * 100 : null,
    dayHigh: null,
    dayLow: null,
    volume: last.volume,
    marketTime: new Date(`${last.date}T00:00:00Z`),
    source,
  };
}
