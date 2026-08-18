/**
 * CoinGecko — the crypto provider.
 *
 * Yahoo can quote BTC-USD, but CoinGecko is the official, documented, keyless
 * option and it carries what Yahoo does not: market cap, circulating supply and
 * total-market aggregates. Crypto's most-quoted numbers are cap-weighted, so it
 * wins for this market.
 *
 * Budget: the free Demo tier allows ~10k calls/month, throttles well below its
 * documented 100/min, and serves at most 365 days of history. Quotes for the
 * whole tracked universe cost ONE call (`/coins/markets` is batched); history
 * costs one call per coin, which is why the frequent refresh runs with
 * range `"none"` and only the daily backfill asks for bars — and why a request
 * beyond the tier's window is declined here rather than attempted.
 *
 * Setting COINGECKO_API_KEY switches to the authenticated Demo host, which is
 * the same data with a higher, per-key allowance. Without it, the public host is
 * used and nothing breaks.
 */
import {
  RANGE_DAYS,
  type AssetRef,
  type BarData,
  type MarketDataProvider,
  type ProviderQuoteResult,
  type QuoteData,
} from "../types";
import { finite as num, mapWithConcurrency } from "./shared";

const PUBLIC_BASE = "https://api.coingecko.com/api/v3";
const PRO_BASE = "https://pro-api.coingecko.com/api/v3";
const TIMEOUT_MS = 20_000;
/**
 * The keyless public tier throttles far below its documented 100/min — a burst of
 * ~5 history calls is enough to earn a 429. So history is fetched one at a time
 * with a pause between calls, and a 429 is retried rather than dropped.
 * A configured API key raises the real ceiling, so the pause shrinks.
 */
const CONCURRENCY = 1;
const PAUSE_MS = 1_500;
/**
 * How far back the public and demo tiers will serve daily history. Asking for
 * more is refused outright (error 10012, "Your request exceeds the allowed time
 * range") — verified against the live API, not inferred from the docs.
 */
const MAX_FREE_HISTORY_DAYS = 365;
const KEYED_PAUSE_MS = 250;
const MAX_RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function endpoint(): { base: string; headers: Record<string, string> } {
  const key = process.env.COINGECKO_API_KEY;
  if (!key) return { base: PUBLIC_BASE, headers: {} };
  // The demo key is accepted on the public host; a pro key needs the pro host.
  return process.env.COINGECKO_PLAN === "pro"
    ? { base: PRO_BASE, headers: { "x-cg-pro-api-key": key } }
    : { base: PUBLIC_BASE, headers: { "x-cg-demo-api-key": key } };
}

/**
 * GET with backoff on 429.
 *
 * Honours `Retry-After` when the server sends one, and otherwise backs off
 * exponentially from `PAUSE_MS`. Any other status is returned as-is for the
 * caller to report.
 */
async function getWithRetry(url: string, init: () => RequestInit): Promise<Response> {
  let wait = PAUSE_MS;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init());
    if (res.status !== 429 || attempt >= MAX_RETRIES) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : wait);
    wait *= 2;
  }
}

interface MarketRow {
  id?: string;
  current_price?: number;
  price_change_24h?: number;
  price_change_percentage_24h?: number;
  high_24h?: number;
  low_24h?: number;
  total_volume?: number;
  market_cap?: number;
  last_updated?: string;
}

/** Map a batched `/coins/markets` response onto the assets that asked for it. */
export function parseMarketsPayload(
  assets: AssetRef[],
  rows: MarketRow[],
): Map<string, QuoteData> {
  const byCoinId = new Map(rows.filter((r) => r.id).map((r) => [r.id!, r]));
  const out = new Map<string, QuoteData>();

  for (const asset of assets) {
    const row = byCoinId.get(asset.sourceSymbol);
    const price = num(row?.current_price);
    if (!row || price == null) continue;

    const changePct = num(row.price_change_percentage_24h);
    const change = num(row.price_change_24h);
    // CoinGecko reports a rolling 24h move, not a session close. Back the implied
    // reference price out of the percentage rather than inventing a "close".
    const previousClose =
      changePct != null && changePct !== -100 ? price / (1 + changePct / 100) : null;

    out.set(asset.id, {
      assetId: asset.id,
      price,
      previousClose,
      change: change ?? (previousClose != null ? price - previousClose : null),
      changePct,
      dayHigh: num(row.high_24h),
      dayLow: num(row.low_24h),
      volume: num(row.total_volume),
      marketTime: row.last_updated ? new Date(row.last_updated) : null,
      source: "coingecko",
    });
  }
  return out;
}

/**
 * Fold `/market_chart` `[epochMs, price][]` into one bar per day.
 *
 * The series ends with a live point whose timestamp is "now", so the final day
 * appears twice; the later reading wins, which is what makes it today's close.
 */
export function parseMarketChart(asset: AssetRef, prices: [number, number][]): BarData[] {
  const byDate = new Map<string, number>();
  for (const [ms, price] of prices) {
    if (!Number.isFinite(ms) || !Number.isFinite(price)) continue;
    byDate.set(new Date(ms).toISOString().slice(0, 10), price);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, close]) => ({
      assetId: asset.id,
      date,
      open: null,
      high: null,
      low: null,
      close,
      volume: null,
      source: "coingecko",
    }));
}


export const coinGeckoProvider: MarketDataProvider = {
  id: "coingecko",
  label: "CoinGecko",

  supports(asset) {
    return asset.source === "coingecko";
  },

  async fetch(assets, range) {
    if (assets.length === 0) return [];
    const { base, headers } = endpoint();
    // A fresh signal per request. Sharing one `init` across every call meant the
    // 20s clock started at the first request, so any retry or later coin was
    // aborted before it began.
    const init = (): RequestInit => ({
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

    // One batched call prices the entire crypto universe.
    let quotes = new Map<string, QuoteData>();
    let quoteError: string | null = null;
    try {
      const ids = assets.map((a) => a.sourceSymbol).join(",");
      const res = await getWithRetry(
        `${base}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&per_page=250&price_change_percentage=24h`,
        init,
      );
      if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);
      quotes = parseMarketsPayload(assets, (await res.json()) as MarketRow[]);
    } catch (e) {
      quoteError = `Could not reach CoinGecko: ${(e as Error).message}`;
    }

    if (range === "none") {
      return assets.map((a) => ({
        assetId: a.id,
        quote: quotes.get(a.id) ?? null,
        bars: [],
        error: quotes.has(a.id) ? null : (quoteError ?? "No CoinGecko row for this coin."),
      }));
    }

    const days = RANGE_DAYS[range];
    const isPro = process.env.COINGECKO_PLAN === "pro";

    // Beyond the tier's window there is nothing to gain by asking: the call is
    // refused, and each refusal costs a slow round trip. Declaring history
    // unavailable hands the asset to the registry's fallback, which re-fetches it
    // whole from Yahoo — so a long backfill takes quote *and* bars from one
    // source, and the quote can never disagree with its own last bar.
    //
    // CoinGecko still earns its place on the frequent path: a quote-only refresh
    // prices the entire crypto universe in one batched call, where Yahoo needs
    // one request per coin.
    if (!isPro && days > MAX_FREE_HISTORY_DAYS) {
      return assets.map((a) => ({
        assetId: a.id,
        quote: quotes.get(a.id) ?? null,
        bars: [],
        error: `CoinGecko's free tier serves at most ${MAX_FREE_HISTORY_DAYS} days of history; ${days} were requested.`,
      }));
    }

    const pause = process.env.COINGECKO_API_KEY ? KEYED_PAUSE_MS : PAUSE_MS;
    let first = true;

    return mapWithConcurrency(assets, CONCURRENCY, async (asset): Promise<ProviderQuoteResult> => {
      const quote = quotes.get(asset.id) ?? null;
      // Spacing the calls out is what keeps the whole run under the limit; the
      // retry above only recovers the ones that slip through anyway.
      if (!first) await sleep(pause);
      first = false;
      try {
        const res = await getWithRetry(
          `${base}/coins/${encodeURIComponent(asset.sourceSymbol)}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
          init,
        );
        if (!res.ok) throw new Error(`CoinGecko responded ${res.status}`);
        const body = (await res.json()) as { prices?: [number, number][] };
        return {
          assetId: asset.id,
          quote,
          bars: parseMarketChart(asset, body.prices ?? []),
          // A quote without history is still useful; say so rather than failing.
          error: quote ? null : (quoteError ?? "No CoinGecko row for this coin."),
        };
      } catch (e) {
        return {
          assetId: asset.id,
          quote,
          bars: [],
          error: `Could not load ${asset.symbol} history: ${(e as Error).message}`,
        };
      }
    });
  },
};
