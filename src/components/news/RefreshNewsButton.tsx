"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Pull fresh headlines and re-render the server component.
 *
 * Sweeps the market feeds and adds a lookup for anything that moved unusually —
 * a handful of requests, unlike the market backfill, so it is safe behind a button.
 */
export default function RefreshNewsButton({ market }: { market?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/news/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(market ? { market } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Refresh failed.");
      if (data.queriesEmpty > 0) {
        setError(`${data.articlesNew} new · ${data.queriesEmpty} feed(s) returned nothing.`);
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
        {busy ? "Fetching…" : "Refresh news"}
      </button>
      {error && <span className="text-xs text-loss">{error}</span>}
    </div>
  );
}
