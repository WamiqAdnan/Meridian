"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { INVESTORS } from "@/lib/investors";
import { MARKETS, MARKET_META, type Market } from "@/lib/markets/types";

export interface AssetOption {
  id: string;
  market: Market;
  symbol: string;
  name: string;
  currency: string;
}

const FIELD =
  "w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-foreground focus:border-accent";
const LABEL = "mb-1 block text-xs font-medium uppercase tracking-wide text-muted";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The asset the form opens on.
 *
 * The list arrives in the database's own order, which is alphabetical by market
 * and so starts at "bonds" — opening a trade form on a Treasury ETF is a strange
 * first impression. Display order puts equities first, matching the rest of the app.
 */
function firstInDisplayOrder(assets: AssetOption[]): string {
  let best: AssetOption | null = null;
  for (const a of assets) {
    if (
      !best ||
      MARKETS.indexOf(a.market) < MARKETS.indexOf(best.market) ||
      (a.market === best.market && a.symbol < best.symbol)
    ) {
      best = a;
    }
  }
  return best?.id ?? "";
}

/**
 * Record a trade by hand.
 *
 * The importer only reads PSX broker statements, so without this there is no way
 * to own bitcoin or a US stock in this app. Two paths, deliberately: pick
 * something already tracked, or name a ticker nobody has tracked yet — the second
 * goes through `POST /api/assets`, which refuses anything a provider cannot
 * actually price.
 */
export default function AddTradeForm({
  assets,
  defaultOwner,
}: {
  assets: AssetOption[];
  defaultOwner?: string;
}) {
  const router = useRouter();

  const [assetId, setAssetId] = useState(() => firstInDisplayOrder(assets));
  const [owner, setOwner] = useState(defaultOwner ?? INVESTORS[0]);
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [tradeDate, setTradeDate] = useState(today());
  const [qty, setQty] = useState("");
  const [rate, setRate] = useState("");
  const [fees, setFees] = useState("");

  const [adding, setAdding] = useState(false);
  const [newMarket, setNewMarket] = useState<Market>("stocks");
  const [newSymbol, setNewSymbol] = useState("");
  const [newName, setNewName] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [known, setKnown] = useState(assets);

  const grouped = useMemo(() => {
    const byMarket = new Map<Market, AssetOption[]>();
    for (const a of known) {
      const bucket = byMarket.get(a.market);
      if (bucket) bucket.push(a);
      else byMarket.set(a.market, [a]);
    }
    return [...byMarket.entries()].sort(
      (a, b) => MARKETS.indexOf(a[0]) - MARKETS.indexOf(b[0]),
    );
  }, [known]);

  const selected = known.find((a) => a.id === assetId) ?? null;

  async function addAsset() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market: newMarket, symbol: newSymbol, name: newName || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not add that symbol.");

      const asset: AssetOption = {
        id: data.asset.id,
        market: data.asset.market,
        symbol: data.asset.symbol,
        name: data.asset.name,
        currency: data.asset.currency,
      };
      setKnown((prev) => (prev.some((a) => a.id === asset.id) ? prev : [...prev, asset]));
      setAssetId(asset.id);
      setAdding(false);
      setNewSymbol("");
      setNewName("");
      setNote(
        data.created
          ? `Now tracking ${asset.symbol}${data.price != null ? ` at ${data.price}` : ""}.`
          : `${asset.symbol} was already tracked.`,
      );
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner, assetId, side, tradeDate, qty, rate, fees }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not save the trade.");

      setNote(`Recorded ${side} ${qty} ${selected?.symbol ?? ""}.`);
      // Keep asset, owner and date — entering several trades in one sitting is
      // the common case, and re-picking the same asset each time is friction.
      setQty("");
      setRate("");
      setFees("");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-line p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Record a trade</h3>
        <button
          type="button"
          onClick={() => {
            setAdding((v) => !v);
            setError(null);
          }}
          className="rounded-md px-2 py-1 text-xs font-medium text-accent hover:bg-surface-raised"
        >
          {adding ? "Cancel" : "+ New symbol"}
        </button>
      </div>

      {adding ? (
        <div className="mb-3 space-y-2 rounded-lg bg-surface-raised p-3">
          <p className="text-xs text-muted">
            We&apos;ll only start tracking it if a price provider can quote it.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL} htmlFor="new-market">Market</label>
              <select
                id="new-market"
                className={FIELD}
                value={newMarket}
                onChange={(e) => setNewMarket(e.target.value as Market)}
              >
                {MARKETS.map((m) => (
                  <option key={m} value={m}>
                    {MARKET_META[m].label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="new-symbol">Ticker</label>
              <input
                id="new-symbol"
                className={FIELD}
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
                placeholder={newMarket === "crypto" ? "SOL" : "AAPL"}
              />
            </div>
          </div>
          <div>
            <label className={LABEL} htmlFor="new-name">Name (optional)</label>
            <input
              id="new-name"
              className={FIELD}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Apple Inc."
            />
          </div>
          <button
            type="button"
            onClick={addAsset}
            disabled={busy || !newSymbol.trim()}
            className="w-full rounded-lg bg-foreground px-3 py-1.5 text-sm font-medium text-background disabled:opacity-50"
          >
            {busy ? "Checking with the provider…" : "Verify and track"}
          </button>
        </div>
      ) : null}

      <div className="space-y-2">
        <div>
          <label className={LABEL} htmlFor="asset">Asset</label>
          <select
            id="asset"
            className={FIELD}
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
            required
          >
            {grouped.map(([market, list]) => (
              <optgroup key={market} label={MARKET_META[market].label}>
                {list.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.symbol} — {a.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={LABEL} htmlFor="side">Side</label>
            <select
              id="side"
              className={FIELD}
              value={side}
              onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}
            >
              <option value="BUY">Buy</option>
              <option value="SELL">Sell</option>
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="owner">Owner</label>
            <select id="owner" className={FIELD} value={owner} onChange={(e) => setOwner(e.target.value)}>
              {INVESTORS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className={LABEL} htmlFor="date">Trade date</label>
          <input
            id="date"
            type="date"
            className={FIELD}
            value={tradeDate}
            max={today()}
            onChange={(e) => setTradeDate(e.target.value)}
            required
          />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className={LABEL} htmlFor="qty">Quantity</label>
            <input
              id="qty"
              className={FIELD}
              // Fractional units are the whole point: 0.05 BTC is a position.
              type="number"
              step="any"
              min="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="0.05"
              required
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="rate">
              Price{selected ? ` (${selected.currency})` : ""}
            </label>
            <input
              id="rate"
              className={FIELD}
              type="number"
              step="any"
              min="0"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder="80000"
              required
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="fees">Fees</label>
            <input
              id="fees"
              className={FIELD}
              type="number"
              step="any"
              min="0"
              value={fees}
              onChange={(e) => setFees(e.target.value)}
              placeholder="0"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={busy || !assetId}
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : `Record ${side.toLowerCase()}`}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-loss/10 px-2.5 py-1.5 text-xs text-loss">
          {error}
        </p>
      )}
      {note && !error && (
        <p className="mt-2 rounded-lg bg-gain/10 px-2.5 py-1.5 text-xs text-gain">{note}</p>
      )}
    </form>
  );
}
