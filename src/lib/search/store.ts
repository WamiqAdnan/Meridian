/**
 * Where search meets the database.
 *
 * The ranker in `rank.ts` is pure; this is the only place it is handed real rows.
 * Same rule as every other `store.ts` here — one module owns the Prisma calls so
 * the engine above it can be exercised offline.
 *
 * The order of work matters: rank the whole catalogue on columns we already have,
 * *then* fetch quotes for the handful that survived. Loading prices for a hundred
 * assets to show ten is the obvious way to make a typeahead feel slow.
 */
import { listAssets, listAssetsWithQuotes } from "@/lib/markets/store";
import { heldAssetIds } from "@/lib/portfolio-view";
import { rankAssets, toCandidate, type SearchHit } from "./rank";

/** A hit with enough price on it to render a row. */
export interface AssetSearchResult extends SearchHit {
  price: number | null;
  /** Day move from the live quote, in percent. */
  changePct: number | null;
}

export interface SearchOptions {
  limit?: number;
  /** Restrict the held-position boost to one investor's book. */
  owner?: string | null;
  /** Skip the ledger lookup entirely — nothing gets the held boost. */
  ignoreHoldings?: boolean;
}

/**
 * Search every tracked asset.
 *
 * Inactive assets are left out: an asset the user has switched off should not
 * come back through the search box, which would be a route around the switch.
 */
export async function searchAssets(
  query: string,
  options: SearchOptions = {},
): Promise<AssetSearchResult[]> {
  if (!query.trim()) return [];

  const [assets, held] = await Promise.all([
    listAssets(),
    options.ignoreHoldings ? Promise.resolve<string[]>([]) : heldAssetIds(options.owner),
  ]);

  const hits = rankAssets(query, assets.map(toCandidate), {
    limit: options.limit,
    heldIds: new Set(held),
  });
  if (hits.length === 0) return [];

  const quotes = new Map(
    (await listAssetsWithQuotes({ ids: hits.map((h) => h.candidate.id) })).map((a) => [a.id, a]),
  );

  return hits.map((hit) => {
    const quote = quotes.get(hit.candidate.id);
    return { ...hit, price: quote?.price ?? null, changePct: quote?.changePct ?? null };
  });
}
