/**
 * Where things live in the app.
 *
 * One definition per destination, so the nine places that link to an asset cannot
 * disagree about the URL. Before this existed, a symbol in the movers list, the
 * holdings table and a news chip each linked to its *market* page, and every one
 * of them had the path written out by hand.
 *
 * Pure — safe to import from a client component.
 */

/**
 * The page for one asset, by asset id.
 *
 * The id carries a colon (`psx:LUCK`), which is legal in a URL path segment and
 * left unescaped on purpose: `/assets/psx:LUCK` is readable and shareable, where
 * `/assets/psx%3ALUCK` is neither. Next decodes the segment either way, so a
 * hand-typed encoded URL still resolves.
 */
export function assetHref(assetId: string): string {
  return `/assets/${assetId}`;
}

/** The market overview page for one market. */
export function marketHref(market: string): string {
  return `/markets/${market}`;
}

/** The search results page for a query. */
export function searchHref(query: string): string {
  return `/search?q=${encodeURIComponent(query)}`;
}
