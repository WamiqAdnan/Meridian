import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { yahooSymbolGuess } from "@/lib/markets/providers/yahoo";
import { fetchAssets } from "@/lib/markets/registry";
import { saveResults } from "@/lib/markets/store";
import { assetId, isMarket, type AssetKind, type AssetRef, type Market } from "@/lib/markets/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One upstream round-trip, but a cold provider can be slow. */
export const maxDuration = 60;

/**
 * Sensible provider defaults per market, so adding "AAPL" needs a ticker and
 * nothing else. Every one of these is overridable in the request — they are a
 * starting guess, and the fetch below is what decides whether the guess was right.
 */
const DEFAULTS: Record<Market, { kind: AssetKind; currency: string; source: string }> = {
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
 * What the chosen provider calls this symbol, absent an explicit `sourceSymbol`.
 *
 * Asks the provider's own vocabulary rather than restating it here. That matters
 * because the guess is *stored*: `yahooSymbolFor` trusts `sourceSymbol` verbatim
 * once a row names Yahoo as its source, so a wrong guess is not corrected on the
 * next refresh — it is a permanent 404 on that row. A bare `USDSAR` made the
 * asset unaddable outright; a bare `GBPJPY` was worse, because the ECB fallback
 * priced it and the broken Yahoo symbol was never noticed.
 *
 * Guessing CoinGecko's slug ("bitcoin") from a ticker is not possible, so the
 * keyless Yahoo path stays the default for crypto and the registry still falls
 * back to CoinGecko for anything it already knows.
 */
function defaultSourceSymbol(
  asset: { market: Market; symbol: string; kind: AssetKind },
  source: string,
): string {
  if (source === "yahoo") return yahooSymbolGuess(asset) ?? asset.symbol;
  return asset.symbol;
}

/**
 * POST /api/assets — start tracking an instrument.
 *
 * Body: `{ market, symbol, name?, kind?, currency?, source?, sourceSymbol? }`
 *
 * The catalogue's standing rule is that every `sourceSymbol` was verified against
 * its provider before being written down. This route holds a user-added asset to
 * the same standard: it fetches a quote first and only writes the row if one
 * comes back. A typo'd ticker fails here rather than becoming a permanently
 * unpriceable position in the ledger.
 *
 * Idempotent — asking for an asset that already exists returns it.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const market = body.market;
  if (!isMarket(market)) {
    return NextResponse.json({ error: `Unknown market: ${String(market)}` }, { status: 400 });
  }

  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!symbol) {
    return NextResponse.json({ error: "A ticker symbol is required." }, { status: 400 });
  }
  if (!/^[A-Z0-9][A-Z0-9.\-/=^]{0,19}$/.test(symbol)) {
    return NextResponse.json({ error: `"${symbol}" is not a usable ticker.` }, { status: 400 });
  }

  const id = assetId(market, symbol);
  const existing = await prisma.asset.findUnique({ where: { id } });
  if (existing) {
    // Re-activate rather than refuse: switching an asset back on is the same
    // action from the user's side as adding it.
    if (!existing.active) await prisma.asset.update({ where: { id }, data: { active: true } });
    return NextResponse.json({ ok: true, asset: existing, created: false });
  }

  const defaults = DEFAULTS[market];
  const str = (v: unknown, fallback: string) =>
    typeof v === "string" && v.trim() ? v.trim() : fallback;

  // Resolved before the ref is built: the default `sourceSymbol` depends on both
  // the kind and the provider, so neither can still be undecided at that point.
  const kind = str(body.kind, defaults.kind) as AssetKind;
  const source = str(body.source, defaults.source);

  const ref: AssetRef = {
    id,
    market,
    symbol,
    name: str(body.name, symbol),
    kind,
    currency: str(body.currency, defaults.currency).toUpperCase(),
    source,
    sourceSymbol: str(body.sourceSymbol, defaultSourceSymbol({ market, symbol, kind }, source)),
    rank: 100,
    // Held, not seeded — it belongs in the movers table but not in the
    // "here is the market" summary.
    benchmark: false,
  };

  let priced;
  try {
    [priced] = await fetchAssets([ref], "none");
  } catch (e) {
    return NextResponse.json(
      { error: `Could not reach a price provider: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  if (!priced?.quote) {
    return NextResponse.json(
      {
        error:
          priced?.error ??
          `No provider could price ${symbol} in ${market}. Check the ticker, or name the provider symbol explicitly.`,
      },
      { status: 422 },
    );
  }

  const asset = await prisma.asset.create({ data: { ...ref, active: true } });
  // Keep the verifying quote instead of throwing it away — the position this
  // asset was added for should be priced the moment it is entered.
  await saveResults([priced]);

  return NextResponse.json({ ok: true, asset, created: true, price: priced.quote.price }, { status: 201 });
}
