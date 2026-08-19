/**
 * Yahoo Finance chart endpoint — the workhorse.
 *
 * One `GET /v8/finance/chart/{symbol}?range=&interval=1d` returns the snapshot,
 * the instrument's metadata and the whole daily series in a single response, and
 * covers equities, ETFs, indices, commodity futures, FX pairs and Treasury yields
 * from the same shape. That breadth is why it is the default provider for every
 * market except crypto and PSX.
 *
 * Known limitations, accepted deliberately:
 *   - Unofficial. Yahoo can change or withdraw it without notice — the same risk
 *     the PSX scrape already carries. `MarketDataProvider` exists so it can be
 *     swapped without touching the engines.
 *   - The batch quote endpoint (/v7/finance/quote) now answers 401 without a
 *     crumb, so this fetches one symbol at a time, bounded by CONCURRENCY.
 *   - Not licensed for redistribution. Personal use only.
 */
import type {
  AssetRef,
  BarData,
  MarketDataProvider,
  ProviderQuoteResult,
  QuoteData,
} from "../types";
import { finite, mapWithConcurrency } from "./shared";

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

/** Polite parallelism: fast enough for a full refresh, gentle enough not to trip throttling. */
const CONCURRENCY = 4;
const TIMEOUT_MS = 15_000;

/** The slice of Yahoo's response we rely on. Everything else is ignored. */
interface ChartPayload {
  chart?: {
    result?: {
      meta?: {
        symbol?: string;
        currency?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
        regularMarketDayHigh?: number;
        regularMarketDayLow?: number;
        regularMarketVolume?: number;
        regularMarketTime?: number;
        instrumentType?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: {
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }[];
      };
    }[];
    error?: { description?: string } | null;
  };
}

/** yyyy-mm-dd in UTC — the ledger's date convention, and stable across timezones. */
export function toDateKey(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Turn one chart response into a quote plus its daily bars.
 *
 * Exported so the check script can exercise every branch — partial rows, null
 * closes, a single-bar series, an error envelope — against a fixture, with no
 * network involved.
 */
export function parseChartPayload(
  asset: AssetRef,
  payload: ChartPayload,
): { quote: QuoteData | null; bars: BarData[]; error: string | null } {
  const upstreamError = payload.chart?.error?.description;
  if (upstreamError) return { quote: null, bars: [], error: upstreamError };

  const result = payload.chart?.result?.[0];
  if (!result) return { quote: null, bars: [], error: "No chart result in response." };

  const stamps = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const closes = q.close ?? [];

  const bars: BarData[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const close = closes[i];
    // A null close is a non-trading slot Yahoo pads into the series. Skipping it
    // is the difference between a real gap and a fabricated flat day.
    if (close == null || !Number.isFinite(close)) continue;
    bars.push({
      assetId: asset.id,
      date: toDateKey(stamps[i]),
      open: finite(q.open?.[i]),
      high: finite(q.high?.[i]),
      low: finite(q.low?.[i]),
      close,
      volume: finite(q.volume?.[i]),
      source: "yahoo",
    });
  }

  const meta = result.meta ?? {};
  const price = finite(meta.regularMarketPrice) ?? bars.at(-1)?.close ?? null;
  if (price == null) {
    return { quote: null, bars, error: "Response carried no usable price." };
  }

  // Prefer the bar before the latest one: for futures and indices Yahoo omits
  // `previousClose` entirely, and `chartPreviousClose` is the close before the
  // *range* started, not before the last session.
  const previousClose =
    bars.length >= 2
      ? bars[bars.length - 2].close
      : (finite(meta.previousClose) ?? finite(meta.chartPreviousClose));

  const change = previousClose != null ? price - previousClose : null;

  return {
    quote: {
      assetId: asset.id,
      price,
      previousClose,
      change,
      changePct: previousClose != null && previousClose !== 0 ? (change! / previousClose) * 100 : null,
      dayHigh: finite(meta.regularMarketDayHigh),
      dayLow: finite(meta.regularMarketDayLow),
      volume: finite(meta.regularMarketVolume),
      marketTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : null,
      source: "yahoo",
    },
    bars,
    error: null,
  };
}


/**
 * What Yahoo calls an instrument, derived from market vocabulary alone.
 *
 * Split out from `yahooSymbolFor` because the two questions are different.
 * `yahooSymbolFor` answers "what should I send for this asset row", and a row
 * that already names Yahoo as its source has the answer written down. This
 * answers "what would Yahoo call this", which is what a caller *choosing* a
 * `sourceSymbol` for a brand-new asset needs — at that point there is nothing
 * written down yet, and the bare ticker is wrong for a coin and for a pair.
 *
 * Returns null for anything Yahoo genuinely does not list, and for the kinds
 * whose Yahoo name is the plain ticker — callers supply that themselves.
 */
export function yahooSymbolGuess(
  asset: Pick<AssetRef, "market" | "symbol" | "kind">,
): string | null {
  if (asset.market === "psx") return null;

  switch (asset.kind) {
    case "crypto":
      return `${asset.symbol.toUpperCase()}-USD`;
    case "fx_pair": {
      const pair = asset.symbol.toUpperCase().replace("/", "");
      if (pair.length !== 6) return null;
      // Yahoo names a USD-base pair by its quote currency alone: PKR=X, not USDPKR=X.
      return pair.startsWith("USD") ? `${pair.slice(3)}=X` : `${pair}=X`;
    }
    default:
      return null;
  }
}

/**
 * The Yahoo symbol for an asset, including assets that prefer another provider.
 *
 * This is what makes Yahoo a genuine fallback rather than a nominal one: when
 * CoinGecko throttles, crypto still prices because Yahoo lists BTC-USD, and the
 * registry can route to it without the asset row changing. Returns null for
 * anything Yahoo genuinely does not list — PSX equities, most obviously.
 */
export function yahooSymbolFor(asset: AssetRef): string | null {
  if (asset.source === "yahoo") return asset.sourceSymbol;
  return yahooSymbolGuess(asset);
}

export const yahooProvider: MarketDataProvider = {
  id: "yahoo",
  label: "Yahoo Finance",

  supports(asset) {
    return yahooSymbolFor(asset) !== null;
  },

  async fetch(assets, range) {
    // `range: "none"` still needs two sessions to compute a daily change, and
    // Yahoo has no quote-only mode on this endpoint — 5d is its cheapest answer.
    const window = range === "none" ? "5d" : range;
    return mapWithConcurrency(assets, CONCURRENCY, async (asset): Promise<ProviderQuoteResult> => {
      const symbol = yahooSymbolFor(asset);
      if (!symbol) {
        return {
          assetId: asset.id,
          quote: null,
          bars: [],
          error: `Yahoo does not list ${asset.symbol}.`,
        };
      }
      const url = `${BASE}/${encodeURIComponent(symbol)}?range=${window}&interval=1d`;
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        });
        if (!res.ok) {
          return {
            assetId: asset.id,
            quote: null,
            bars: [],
            error: `Yahoo responded ${res.status} for ${symbol}`,
          };
        }
        const parsed = parseChartPayload(asset, (await res.json()) as ChartPayload);
        return { assetId: asset.id, ...parsed, bars: range === "none" ? [] : parsed.bars };
      } catch (e) {
        return {
          assetId: asset.id,
          quote: null,
          bars: [],
          error: `Could not reach Yahoo for ${symbol}: ${(e as Error).message}`,
        };
      }
    });
  },
};
