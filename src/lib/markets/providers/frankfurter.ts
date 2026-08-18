/**
 * Frankfurter — European Central Bank reference rates.
 *
 * Keyless, officially sourced, rate-limit free, and it will still be there when
 * an unofficial endpoint is not. That makes it the FX fallback rather than the FX
 * default: it publishes one reference rate per currency per working day, so it
 * has no intraday tick and no weekend value, which is a poor fit for a live
 * dashboard but exactly right when Yahoo is unavailable.
 *
 * Registered as a fallback in `registry.ts`; nothing is seeded against it.
 */
import {
  RANGE_DAYS,
  type AssetRef,
  type BarData,
  type MarketDataProvider,
  type ProviderQuoteResult,
} from "../types";
import { quoteFromBars } from "./shared";

const BASE = "https://api.frankfurter.dev/v1";
const TIMEOUT_MS = 15_000;

/** The currencies the ECB publishes. Anything else this provider must decline. */
const SUPPORTED = new Set([
  "AUD", "BGN", "BRL", "CAD", "CHF", "CNY", "CZK", "DKK", "EUR", "GBP", "HKD",
  "HUF", "IDR", "ILS", "INR", "ISK", "JPY", "KRW", "MXN", "MYR", "NOK", "NZD",
  "PHP", "PLN", "RON", "SEK", "SGD", "THB", "TRY", "USD", "ZAR",
]);

/**
 * Split a six-letter pair symbol into base and quote.
 * Returns null when either leg is one the ECB does not publish (PKR, AED).
 */
export function splitPair(symbol: string): { base: string; quote: string } | null {
  const s = symbol.toUpperCase().replace("/", "");
  if (s.length !== 6) return null;
  const base = s.slice(0, 3);
  const quote = s.slice(3);
  if (!SUPPORTED.has(base) || !SUPPORTED.has(quote)) return null;
  return { base, quote };
}

interface TimeseriesPayload {
  rates?: Record<string, Record<string, number>>;
}

/** Fold `{ "2026-08-15": { "PKR": 277.6 } }` into daily bars, oldest-first. */
export function parseTimeseries(
  asset: AssetRef,
  quoteCurrency: string,
  payload: TimeseriesPayload,
): BarData[] {
  const rates = payload.rates ?? {};
  return Object.entries(rates)
    .map(([date, byCurrency]) => ({ date, close: byCurrency?.[quoteCurrency] }))
    .filter((r): r is { date: string; close: number } => typeof r.close === "number" && Number.isFinite(r.close))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ date, close }) => ({
      assetId: asset.id,
      date,
      open: null,
      high: null,
      low: null,
      close,
      volume: null,
      source: "frankfurter",
    }));
}

export const frankfurterProvider: MarketDataProvider = {
  id: "frankfurter",
  label: "Frankfurter (ECB)",

  supports(asset) {
    return asset.kind === "fx_pair" && splitPair(asset.symbol) !== null;
  },

  async fetch(assets, range) {
    const from =
      range === "none"
        ? new Date(Date.now() - 10 * 86_400_000) // enough to find the last two working days
        : new Date(Date.now() - RANGE_DAYS[range] * 86_400_000);
    const start = from.toISOString().slice(0, 10);

    return Promise.all(
      assets.map(async (asset): Promise<ProviderQuoteResult> => {
        const pair = splitPair(asset.symbol);
        if (!pair) {
          return {
            assetId: asset.id,
            quote: null,
            bars: [],
            error: `The ECB does not publish ${asset.symbol}.`,
          };
        }
        try {
          const res = await fetch(
            `${BASE}/${start}..?base=${pair.base}&symbols=${pair.quote}`,
            {
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(TIMEOUT_MS),
              cache: "no-store",
            },
          );
          if (!res.ok) throw new Error(`Frankfurter responded ${res.status}`);
          const bars = parseTimeseries(asset, pair.quote, (await res.json()) as TimeseriesPayload);
          const quote = quoteFromBars(asset.id, bars, "frankfurter");
          return {
            assetId: asset.id,
            quote,
            bars: range === "none" ? [] : bars,
            error: quote ? null : "Frankfurter returned no rates for this pair.",
          };
        } catch (e) {
          return {
            assetId: asset.id,
            quote: null,
            bars: [],
            error: `Could not reach Frankfurter: ${(e as Error).message}`,
          };
        }
      }),
    );
  },
};
