import Link from "next/link";
import { getPortfolio } from "@/lib/portfolio";
import { DEFAULT_INDEX, getIndexConstituents, type IndexSnapshot } from "@/lib/psx-index";
import ReplicatorPanel from "@/components/ReplicatorPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Build a weight-matched, whole-share buy plan from a live index.
 *
 * The arithmetic all happens in the client panel, so the plan updates as you type.
 * The server fetches the default index up front (the page arrives ready to use) and
 * hands over the ledger context that makes the panel easier to drive: which symbols
 * you already hold, and the last price we cached for them — used only as a fallback
 * when a pasted row is missing its price.
 */
export default async function ReplicatePage() {
  const [{ holdings, pricesFetchedAt }, index] = await Promise.all([
    getPortfolio(null),
    getIndexConstituents(DEFAULT_INDEX).then(
      (snapshot): { snapshot: IndexSnapshot | null; error: string | null } => ({
        snapshot,
        error: null,
      }),
      // The feed being down shouldn't cost you the page — you can still paste a table.
      (e: Error) => ({
        snapshot: null,
        error: `Could not reach the PSX index feed: ${e.message}. Try Refresh, or paste a table instead.`,
      }),
    ),
  ]);

  const fallbackPrices: Record<string, number> = {};
  for (const h of holdings) {
    if (h.livePrice != null) fallbackPrices[h.security] = h.livePrice;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Index Replicator</h1>
          <p className="text-sm text-neutral-500">
            Pick an index and how many of its top names to hold, name an amount — get the
            whole-share buy list that matches those weights, fees included.
          </p>
        </div>
        <Link
          href="/"
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          ← Dashboard
        </Link>
      </header>

      <ReplicatorPanel
        heldSymbols={holdings.map((h) => h.security)}
        fallbackPrices={fallbackPrices}
        initialSnapshot={index.snapshot}
        initialError={index.error}
      />

      {pricesFetchedAt && (
        <p className="mt-6 text-xs text-neutral-500">
          Fallback prices for rows marked * come from the dashboard cache, last updated{" "}
          {new Date(pricesFetchedAt as Date).toLocaleString("en-PK", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
          .
        </p>
      )}
    </div>
  );
}
