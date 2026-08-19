/**
 * Turning a request body into an asset row.
 *
 * `POST /api/assets` is the only way a row enters the Asset table that did not
 * come from the hand-verified catalogue, so it is the only place the table's
 * invariants can be broken. Everything downstream trusts those columns without
 * re-checking them: `fxTableFromAssets` selects on `kind`, `convert` looks
 * `currency` up in the FX table, `preferredProvider` resolves `source` to a
 * provider, and `assetHref` drops `id` straight into a URL path. A column that
 * is merely a string at this boundary is a wrong number or a dead link later.
 *
 * Pure — no database, no network, no Prisma. The route does the IO; this decides
 * what the row should say. That split is also what lets the check script
 * exercise every rejection without a server.
 */
import { isMoney } from "./currency";
import { PROVIDERS } from "./registry";
import {
  ASSET_KINDS,
  assetId,
  isAssetKind,
  isMarket,
  type AssetKind,
  type AssetRef,
  type MarketDataProvider,
  type Market,
} from "./types";
import { yahooSymbolGuess } from "./providers/yahoo";

/**
 * Sensible provider defaults per market, so adding "AAPL" needs a ticker and
 * nothing else. Every one of these is overridable in the request — they are a
 * starting guess, and the fetch the route runs is what decides whether the guess
 * was right.
 */
export const DEFAULTS: Record<Market, { kind: AssetKind; currency: string; source: string }> = {
  stocks: { kind: "stock", currency: "USD", source: "yahoo" },
  crypto: { kind: "crypto", currency: "USD", source: "yahoo" },
  commodities: { kind: "commodity", currency: "USD", source: "yahoo" },
  forex: { kind: "fx_pair", currency: "USD", source: "yahoo" },
  indices: { kind: "index", currency: "PTS", source: "yahoo" },
  bonds: { kind: "bond_yield", currency: "PCT", source: "yahoo" },
  real_estate: { kind: "reit", currency: "USD", source: "yahoo" },
  psx: { kind: "stock", currency: "PKR", source: "psx" },
};

/**
 * Characters a ticker may contain, after normalisation.
 *
 * Notably absent: `/`. An asset's id is `{market}:{symbol}` and `assetHref` puts
 * it in a URL path unescaped on purpose, so a slash in the symbol splits the id
 * across two path segments and 404s from every link in the app. The slash is not
 * load-bearing anywhere — `buildFxTable` and `splitPair` both strip it before
 * reading a pair — so it is normalised away below rather than rejected, and
 * `USD/PKR` resolves to the `forex:USDPKR` the catalogue already holds.
 */
const TICKER = /^[A-Z0-9][A-Z0-9.\-=^]{0,19}$/;

/** ISO 4217, plus the two notional codes the formatters key on ("PTS", "PCT"). */
const CURRENCY = /^[A-Z]{3}$/;

/** Uppercased and stripped of the one character an id cannot survive. */
export function normaliseSymbol(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase().replace(/\//g, "") : "";
}

export type AdoptResult =
  | { ok: true; ref: AssetRef }
  | { ok: false; error: string };

/**
 * What the chosen provider calls this symbol, absent an explicit `sourceSymbol`.
 *
 * Asks the provider's own vocabulary rather than restating it here. That matters
 * because the guess is *stored*: `yahooSymbolFor` trusts `sourceSymbol` verbatim
 * once a row names Yahoo as its source, so a wrong guess is not corrected on the
 * next refresh — it is a permanent 404 on that row.
 *
 * Guessing CoinGecko's slug ("bitcoin") from a ticker is not possible, so the
 * keyless Yahoo path stays the default for crypto and the registry still falls
 * back to CoinGecko for anything it already knows.
 */
export function defaultSourceSymbol(
  asset: { market: Market; symbol: string; kind: AssetKind },
  source: string,
): string {
  if (source === "yahoo") return yahooSymbolGuess(asset) ?? asset.symbol;
  return asset.symbol;
}

/**
 * The currency a price is quoted in, where the kind settles it.
 *
 * `DEFAULTS` is keyed by market, and for three kinds the market is not enough to
 * answer. A pair is quoted in its second leg: `USDPKR` is a number of rupees, so
 * storing it as USD renders the asset page as `$277.60` and converts a holding
 * through the wrong rate. An index is a level and a yield is a percentage, and
 * the formatters key on "PTS" and "PCT" to say so.
 *
 * The market default is still the answer for every kind that is plainly money —
 * except when the market's own default is notional. `bonds` defaults to "PCT"
 * because most of it is yields, but six of its rows are ETFs that trade in
 * dollars, and a notional code is never right for something with a price.
 *
 * Not a new convention — every one of the catalogue's rows already follows this,
 * which the check script asserts against the catalogue itself. It was only the
 * user-added path that had never been told.
 */
function defaultCurrency(symbol: string, kind: AssetKind, fallback: string): string {
  if (kind === "index") return "PTS";
  if (kind === "bond_yield") return "PCT";
  if (kind === "fx_pair" && symbol.length === 6) return symbol.slice(3);
  return isMoney(fallback) ? fallback : "USD";
}

/**
 * Validate a request body and describe the row it asks for.
 *
 * Rejects rather than coerces: a body that names a kind, currency or source the
 * app does not know is a mistake worth reporting, not one worth guessing past.
 * The alternative was writing the string down and discovering it as a position
 * missing from a total weeks later.
 */
export function adoptAsset(
  body: Record<string, unknown>,
  /** Overridable so the check script can exercise routing offline. */
  registry: MarketDataProvider[] = PROVIDERS,
): AdoptResult {
  const market = body.market;
  if (!isMarket(market)) {
    return { ok: false, error: `Unknown market: ${String(market)}` };
  }

  const symbol = normaliseSymbol(body.symbol);
  if (!symbol) {
    return { ok: false, error: "A ticker symbol is required." };
  }
  if (!TICKER.test(symbol)) {
    return { ok: false, error: `"${symbol}" is not a usable ticker.` };
  }

  const defaults = DEFAULTS[market];
  const str = (v: unknown, fallback: string) =>
    typeof v === "string" && v.trim() ? v.trim() : fallback;

  const kind = str(body.kind, defaults.kind);
  if (!isAssetKind(kind)) {
    return { ok: false, error: `Unknown kind: ${kind}. Expected one of ${ASSET_KINDS.join(", ")}.` };
  }

  const currency = str(body.currency, defaultCurrency(symbol, kind, defaults.currency)).toUpperCase();
  if (!CURRENCY.test(currency)) {
    return { ok: false, error: `"${currency}" is not a currency code.` };
  }

  const source = str(body.source, defaults.source);
  if (!registry.some((p) => p.id === source)) {
    return {
      ok: false,
      error: `No provider called ${source}. Known providers: ${registry.map((p) => p.id).join(", ")}.`,
    };
  }

  return {
    ok: true,
    ref: {
      id: assetId(market, symbol),
      market,
      symbol,
      name: str(body.name, symbol),
      kind,
      currency,
      source,
      sourceSymbol: str(body.sourceSymbol, defaultSourceSymbol({ market, symbol, kind }, source)),
      rank: 100,
      // Held, not seeded — it belongs in the movers table but not in the
      // "here is the market" summary.
      benchmark: false,
    },
  };
}
