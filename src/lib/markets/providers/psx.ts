/**
 * Pakistan Stock Exchange — the market this app started with.
 *
 * Two upstreams, because neither alone is enough:
 *
 *   market-watch  the existing HTML scrape (see lib/psx-prices.ts). Intraday
 *                 prices for every listed equity, in one request. Carries no
 *                 history and no index levels.
 *   timeseries/eod/{symbol}
 *                 a JSON endpoint returning ~5 years of daily closes as
 *                 [epochSeconds, close, volume, …]. Works for equities *and*
 *                 index codes (KSE100, KSE30, KMI30, ALLSHR), which is the only
 *                 way to get an index level at all.
 *
 * The fourth column of an EOD row tracks close without matching it and is not
 * documented anywhere; it is deliberately ignored rather than guessed at.
 *
 * Index quotes come from the newest EOD row, so during a live session an index
 * shows the previous close while individual equities are live. Marked on the UI
 * rather than papered over.
 */
import { fetchMarketWatch } from "@/lib/psx-prices";
import {
  RANGE_DAYS,
  type AssetRef,
  type BarData,
  type MarketDataProvider,
  type ProviderQuoteResult,
  type QuoteData,
} from "../types";
import { mapWithConcurrency, quoteFromBars } from "./shared";

const EOD_URL = "https://dps.psx.com.pk/timeseries/eod";
const TIMEOUT_MS = 20_000;
const CONCURRENCY = 3;

/** PSX index codes, which market-watch does not list. */
const INDEX_CODES = new Set(["KSE100", "KSE30", "KMI30", "ALLSHR", "KMIALLSHR", "PSXDIV20"]);

export function isPsxIndex(symbol: string): boolean {
  return INDEX_CODES.has(symbol.toUpperCase());
}

interface EodPayload {
  status?: number;
  message?: string;
  data?: unknown[][];
}

/**
 * Decode an EOD payload into daily bars, newest-last.
 *
 * Exported for the check script: rows arrive newest-first, occasionally carry a
 * null close, and the row shape is positional, so this is worth pinning down
 * without a network call.
 */
export function parseEodPayload(
  asset: AssetRef,
  payload: EodPayload,
  sinceDate?: string,
): { bars: BarData[]; error: string | null } {
  if (payload.status !== 1) {
    return { bars: [], error: payload.message || "PSX EOD feed reported a failure." };
  }
  const rows = payload.data;
  if (!Array.isArray(rows)) return { bars: [], error: "PSX EOD feed returned no data array." };

  const bars: BarData[] = [];
  for (const row of rows) {
    const epoch = row?.[0];
    const close = row?.[1];
    const volume = row?.[2];
    if (typeof epoch !== "number" || typeof close !== "number" || !Number.isFinite(close)) continue;
    const date = new Date(epoch * 1000).toISOString().slice(0, 10);
    if (sinceDate && date < sinceDate) continue;
    bars.push({
      assetId: asset.id,
      date,
      open: null,
      high: null,
      low: null,
      close,
      volume: typeof volume === "number" && Number.isFinite(volume) ? volume : null,
      source: "psx",
    });
  }

  bars.sort((a, b) => a.date.localeCompare(b.date));
  return { bars, error: bars.length === 0 ? "PSX EOD feed returned no usable rows." : null };
}

function earliestDateFor(range: Exclude<Parameters<MarketDataProvider["fetch"]>[1], "none">): string {
  const days = RANGE_DAYS[range];
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export const psxProvider: MarketDataProvider = {
  id: "psx",
  label: "Pakistan Stock Exchange",

  supports(asset) {
    return asset.source === "psx";
  },

  async fetch(assets, range) {
    if (assets.length === 0) return [];

    const equities = assets.filter((a) => !isPsxIndex(a.symbol));
    const indices = assets.filter((a) => isPsxIndex(a.symbol));

    // One scrape prices every listed equity. Index codes never appear in it.
    const live = new Map<string, { price: number; change: number | null; changePct: number | null }>();
    let liveError: string | null = null;
    if (equities.length > 0) {
      try {
        for (const row of await fetchMarketWatch(TIMEOUT_MS)) {
          live.set(row.symbol, { price: row.price, change: row.change, changePct: row.changePct });
        }
      } catch (e) {
        liveError = `Could not reach the PSX market-watch feed: ${(e as Error).message}`;
      }
    }

    const wantHistory = range !== "none";
    const since = wantHistory ? earliestDateFor(range) : undefined;
    // Index levels only exist in the EOD feed, so they are fetched even when the
    // caller asked for quotes alone.
    const needsEod = wantHistory ? assets : indices;
    const eodFor = new Map<string, BarData[]>();
    const eodError = new Map<string, string>();

    await mapWithConcurrency(needsEod, CONCURRENCY, async (asset) => {
      try {
        const res = await fetch(`${EOD_URL}/${encodeURIComponent(asset.sourceSymbol)}`, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`PSX responded ${res.status}`);
        // An index quote needs only the last two rows, but the feed has no range
        // parameter, so trimming happens here rather than upstream.
        const { bars, error } = parseEodPayload(asset, (await res.json()) as EodPayload, since);
        if (error) eodError.set(asset.id, error);
        eodFor.set(asset.id, bars);
      } catch (e) {
        eodError.set(asset.id, `Could not load ${asset.symbol} history: ${(e as Error).message}`);
      }
    });

    return assets.map((asset): ProviderQuoteResult => {
      const bars = eodFor.get(asset.id) ?? [];
      const tick = live.get(asset.sourceSymbol);

      const quote: QuoteData | null = tick
        ? {
            assetId: asset.id,
            price: tick.price,
            previousClose: tick.change != null ? tick.price - tick.change : (bars.at(-2)?.close ?? null),
            change: tick.change,
            changePct: tick.changePct,
            dayHigh: null,
            dayLow: null,
            volume: null,
            marketTime: new Date(),
            source: "psx",
          }
        : quoteFromBars(asset.id, bars, "psx");

      return {
        assetId: asset.id,
        quote,
        bars,
        error: quote ? null : (eodError.get(asset.id) ?? liveError ?? "No PSX data for this symbol."),
      };
    });
  },
};
