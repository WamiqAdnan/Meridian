/**
 * Which provider prices which asset — and what happens when it can't.
 *
 * Assets name a preferred `source`; the registry batches them by provider, calls
 * each provider once, and then retries anything that failed against any other
 * provider that claims to support it. So Yahoo going dark degrades FX to the
 * ECB's reference rates rather than blanking the forex market, and a market with
 * no fallback returns a stated error instead of a silently empty page.
 *
 * Nothing here touches the database. `refresh.ts` decides what to persist.
 */
import type {
  AssetRef,
  HistoryRange,
  MarketDataProvider,
  ProviderQuoteResult,
} from "./types";
import { coinGeckoProvider } from "./providers/coingecko";
import { frankfurterProvider } from "./providers/frankfurter";
import { psxProvider } from "./providers/psx";
import { yahooProvider } from "./providers/yahoo";

/** Registration order is preference order when an asset's own source fails. */
export const PROVIDERS: MarketDataProvider[] = [
  yahooProvider,
  coinGeckoProvider,
  psxProvider,
  frankfurterProvider,
];

export function providerById(
  id: string,
  registry: MarketDataProvider[] = PROVIDERS,
): MarketDataProvider | undefined {
  return registry.find((p) => p.id === id);
}

/** The provider an asset asks for, if it is registered and willing. */
export function preferredProvider(
  asset: AssetRef,
  registry: MarketDataProvider[] = PROVIDERS,
): MarketDataProvider | undefined {
  const p = providerById(asset.source, registry);
  return p?.supports(asset) ? p : undefined;
}

/** Every registered provider that can price this asset, preferred one first. */
export function candidateProviders(
  asset: AssetRef,
  registry: MarketDataProvider[] = PROVIDERS,
): MarketDataProvider[] {
  const preferred = preferredProvider(asset, registry);
  const rest = registry.filter((p) => p !== preferred && p.supports(asset));
  return preferred ? [preferred, ...rest] : rest;
}

/** Did this result answer everything that was asked for? */
function isComplete(r: ProviderQuoteResult | undefined, range: HistoryRange): boolean {
  if (!r?.quote) return false;
  return range === "none" || r.bars.length > 0;
}

/** 2 = complete, 1 = priced but thin, 0 = nothing. Used to keep the better attempt. */
function score(r: ProviderQuoteResult, range: HistoryRange): number {
  if (isComplete(r, range)) return 2;
  return r.quote ? 1 : 0;
}

/**
 * Fetch every asset, batching by provider and falling back on failure.
 *
 * Resolves with exactly one result per input asset, in input order. A provider
 * that throws outright is treated as having failed every asset it was given —
 * one broken upstream never takes the refresh down with it.
 */
export async function fetchAssets(
  assets: AssetRef[],
  range: HistoryRange,
  /** Overridable so the check script can exercise routing and fallback offline. */
  registry: MarketDataProvider[] = PROVIDERS,
): Promise<ProviderQuoteResult[]> {
  if (assets.length === 0) return [];

  const results = new Map<string, ProviderQuoteResult>();
  const attempted = new Map<string, Set<string>>();

  const runRound = async (batch: AssetRef[], pick: (a: AssetRef) => MarketDataProvider | undefined) => {
    const routed = new Map<string, { provider: MarketDataProvider; assets: AssetRef[] }>();
    const unroutable: AssetRef[] = [];

    for (const asset of batch) {
      const provider = pick(asset);
      if (!provider) {
        unroutable.push(asset);
        continue;
      }
      const entry = routed.get(provider.id);
      if (entry) entry.assets.push(asset);
      else routed.set(provider.id, { provider, assets: [asset] });

      let tried = attempted.get(asset.id);
      if (!tried) attempted.set(asset.id, (tried = new Set()));
      tried.add(provider.id);
    }

    for (const asset of unroutable) {
      const existing = results.get(asset.id);
      // Keep anything that already carries a price. On the retry round an asset
      // reaches here when no untried provider is left — including one that was
      // quoted but had no history. Overwriting it with a null result would throw
      // away a good price to record "no provider", which is both a lie and worse
      // data than what we had.
      if (existing?.quote) continue;
      results.set(asset.id, {
        assetId: asset.id,
        quote: null,
        bars: [],
        error: existing?.error ?? `No provider is configured to price ${asset.symbol}.`,
      });
    }

    await Promise.all(
      [...routed.values()].map(async ({ provider, assets: batchAssets }) => {
        let round: ProviderQuoteResult[];
        try {
          round = await provider.fetch(batchAssets, range);
        } catch (e) {
          // A provider that throws rather than reporting per-asset errors is a
          // bug in that provider; contain it here instead of losing the refresh.
          round = batchAssets.map((a) => ({
            assetId: a.id,
            quote: null,
            bars: [],
            error: `${provider.label} failed outright: ${(e as Error).message}`,
          }));
        }
        for (const r of round) {
          const existing = results.get(r.assetId);
          // Never let a failed retry overwrite a result that already worked, and
          // keep whichever attempt actually produced bars.
          if (existing && score(existing, range) >= score(r, range)) continue;
          results.set(r.assetId, r);
        }
      }),
    );
  };

  await runRound(assets, (a) => preferredProvider(a, registry));

  // Retry against any provider not yet tried. "Failed" includes a result that
  // carries a price but no history when history was asked for — otherwise a
  // provider that throttles its history endpoint (CoinGecko does, on the keyless
  // tier) leaves permanent gaps that no fallback ever fills.
  const failed = assets.filter((a) => !isComplete(results.get(a.id), range));
  if (failed.length > 0) {
    await runRound(failed, (asset) => {
      const tried = attempted.get(asset.id) ?? new Set<string>();
      return candidateProviders(asset, registry).find((p) => !tried.has(p.id));
    });
  }

  return assets.map(
    (a) =>
      results.get(a.id) ?? {
        assetId: a.id,
        quote: null,
        bars: [],
        error: "No provider returned a result.",
      },
  );
}
