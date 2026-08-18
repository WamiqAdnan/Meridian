import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { fmtPrice } from "@/lib/format";
import { MATCH_LABEL } from "@/lib/search/rank";
import { searchAssets } from "@/lib/search/store";
import { toRow, type SearchRow } from "@/lib/search/view";
import Change from "@/components/markets/Change";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Search",
  description: "Find any tracked asset by ticker, name, synonym or market.",
};

/** Enough to show everything a real query finds, without paging. */
const LIMIT = 40;

/**
 * The whole result set for a query.
 *
 * This page is the search, and the nav dropdown is a shortcut to it — not the
 * other way round. It renders on the server from the same ranker, so search works
 * with JavaScript off, is linkable, and is what the nav form submits to.
 *
 * Read-only: no refresh is triggered here. A search must not be a way to make the
 * app go and fetch ninety quotes.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const raw = (await searchParams).q ?? "";
  const query = raw.trim();
  const rows = query ? (await searchAssets(query, { limit: LIMIT })).map(toRow) : [];

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-muted">
          {query
            ? `${rows.length} match${rows.length === 1 ? "" : "es"} for “${query}”`
            : "Every tracked asset, by ticker, name, synonym or market."}
        </p>
      </header>

      <Form action="/search" className="mb-6 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="AAPL, bullion, the Dow, Pakistan…"
          aria-label="Search assets"
          autoComplete="off"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-muted focus:border-accent"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg border border-line px-3 py-2 text-sm font-medium transition-colors hover:bg-surface-raised"
        >
          Search
        </button>
      </Form>

      {!query ? (
        <div className="rounded-xl border border-dashed border-line p-8 text-sm text-muted">
          <p className="font-medium text-foreground">Try a ticker, a name, or what a headline would call it.</p>
          <p className="mt-2">
            A ticker or a full name is matched first. Below that come synonyms — the words
            publishers actually use — so <code className="font-mono">bullion</code> finds Gold,{" "}
            <code className="font-mono">the Dow</code> finds the Dow Jones, and{" "}
            <code className="font-mono">greenback</code> finds the dollar index. Those are the same
            synonyms that attach a story to an asset in the news layer, so anything findable here is
            recognisable there.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line p-8 text-sm text-muted">
          <p className="font-medium text-foreground">Nothing tracked matches “{query}”.</p>
          <p className="mt-1">
            The catalogue is the seeded universe plus whatever the ledger holds — not every listed
            instrument. Record a trade in it on the{" "}
            <Link href="/portfolio" className="text-accent underline-offset-2 hover:underline">
              portfolio page
            </Link>{" "}
            and it becomes tracked, and searchable.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ row }: { row: SearchRow }) {
  return (
    <li>
      <Link
        href={row.href}
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-3 hover:bg-surface-raised"
      >
        <span className="font-semibold">{row.symbol}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted">{row.name}</span>
        {row.held && (
          <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-muted">held</span>
        )}
        <span className="text-sm tabular-nums">{fmtPrice(row.price, row.currency)}</span>
        <Change
          changePct={row.changePct}
          currency={row.currency}
          className="w-20 text-right text-sm font-medium"
        />
        <span className="basis-full text-xs text-muted">
          {row.marketLabel} · matched on {MATCH_LABEL[row.field]}
          {row.note && ` — ${row.note}`}
        </span>
      </Link>
    </li>
  );
}
