import type { Metadata } from "next";
import Link from "next/link";
import { loadPortfolio } from "@/lib/portfolio-view";
import { DEFAULT_INDEX, getIndexConstituents, type IndexSnapshot } from "@/lib/psx-index";
import ReplicatorPanel from "@/components/ReplicatorPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Index Replicator",
  description:
    "Turn an index and a rupee amount into a whole-share buy list that matches its weights, fees included.",
};

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
  const [{ positions, pricesFetchedAt }, index] = await Promise.all([
    loadPortfolio(),
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

  // The replicator buys PSX index constituents, so only PSX positions are
  // relevant here — and a fallback price has to be in rupees to be usable.
  const psx = positions.filter((p) => p.market === "psx");
  const fallbackPrices: Record<string, number> = {};
  for (const p of psx) {
    if (p.price != null) fallbackPrices[p.symbol] = p.price;
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Index Replicator</h1>
          <p className="text-sm text-muted">
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
        heldSymbols={psx.map((p) => p.symbol)}
        fallbackPrices={fallbackPrices}
        initialSnapshot={index.snapshot}
        initialError={index.error}
      />

      {pricesFetchedAt && (
        <p className="mt-6 text-xs text-muted">
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
