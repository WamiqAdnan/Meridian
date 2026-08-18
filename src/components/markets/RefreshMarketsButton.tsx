"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Pull fresh quotes and re-render the server component.
 *
 * Quotes only — a history backfill is a per-asset fetch across the whole universe
 * and belongs in `npm run market:backfill`, not behind a button someone might
 * press repeatedly.
 */
export default function RefreshMarketsButton({ market }: { market?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/markets/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(market ? { market } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Refresh failed.");
      if (data.failed > 0) {
        setError(`${data.quotesWritten} updated, ${data.failed} unavailable.`);
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={refresh}
        disabled={busy}
        className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-raised disabled:opacity-50"
      >
        {busy ? "Refreshing…" : "Refresh prices"}
      </button>
      {error && <span className="text-xs text-loss">{error}</span>}
    </div>
  );
}
