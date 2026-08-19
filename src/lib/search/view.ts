/**
 * The flat shape a search result crosses the wire in.
 *
 * `/api/search` serialises this, the nav dropdown consumes it, and `/search`
 * renders the same thing server-side. One shape for all three, so the typeahead
 * and the results page cannot disagree about what a hit is.
 *
 * Pure. The only import that is not a type is `assetHref`, so a client component
 * can import from here without pulling the database layer into the browser bundle.
 */
import { assetHref } from "@/lib/routes";
import type { AssetKind, Market } from "@/lib/markets/types";
import type { MatchField, SearchHit } from "./rank";
import type { AssetSearchResult } from "./store";

export interface SearchRow {
  id: string;
  symbol: string;
  name: string;
  market: Market;
  marketLabel: string;
  kind: AssetKind;
  currency: string;
  price: number | null;
  changePct: number | null;
  /** Which field matched, and the text that matched it. */
  field: MatchField;
  matched: string;
  score: number;
  /** True when the ledger holds this asset. */
  held: boolean;
  /**
   * Why this row is here, when that is not obvious from the symbol and name on
   * screen. Null for the self-evident cases.
   */
  note: string | null;
  href: string;
}

/**
 * How a match is explained, or null when it needs no explaining.
 *
 * A row found by ticker or name shows the ticker and the name, so saying "matched
 * the name" adds nothing. A row found by a synonym or by its market looks
 * arbitrary without a reason — "bullion" returning Gold reads as a bug until the
 * row says why. Same instinct as showing `NewsMatch.via` next to a headline.
 */
export function noteFor(hit: Pick<SearchHit, "field" | "matched">): string | null {
  switch (hit.field) {
    case "alias":
      return `also called “${hit.matched}”`;
    case "market":
      return `in ${hit.matched}`;
    default:
      return null;
  }
}

export function toRow(result: AssetSearchResult): SearchRow {
  const { candidate } = result;
  return {
    id: candidate.id,
    symbol: candidate.symbol,
    name: candidate.name,
    market: candidate.market,
    marketLabel: candidate.marketLabel,
    kind: candidate.kind,
    currency: candidate.currency,
    price: result.price,
    changePct: result.changePct,
    field: result.field,
    matched: result.matched,
    score: result.score,
    held: result.held,
    note: noteFor(result),
    href: assetHref(candidate.id),
  };
}
