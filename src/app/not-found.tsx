import Link from "next/link";
import { MARKETS, MARKET_META } from "@/lib/markets/types";
import { marketHref } from "@/lib/routes";

/**
 * The 404 for the whole app. An unmatched URL, an untracked asset id and an
 * unknown market all arrive here.
 *
 * It leads with the search box rather than an apology, because every route to
 * this page is a failed lookup of something the reader already had a name for.
 * "Return home" answers none of them; a search box answers all three.
 *
 * **It cannot name what was missing, and that is a constraint rather than a
 * shortcut.** A `not-found.tsx` receives no props — not even the path that
 * missed. A Client Component may read `usePathname`, but that was measured both
 * ways and never lands in the HTML: on an unmatched URL this page is prerendered,
 * so `usePathname` is empty at build time, and on a dynamic route the specific
 * message arrives only after hydration. A message that is only sometimes there is
 * worth less than a general one that always is.
 *
 * **Worth knowing before wondering why a 404 looks blank:** in Next 16 a
 * `notFound()` thrown at request time — `/assets/psx:NOPE`, `/markets/nope` —
 * renders into the `__next_error__` shell with *no visible server-rendered body*
 * at all. Next's own built-in 404 does the same thing, so it is upstream of this
 * file and nothing here can fix it; the page still returns a real 404 and still
 * renders once JavaScript runs. Only the unmatched-URL case is server-rendered,
 * which is why everything on this page is a Server Component and the search box
 * is a plain `<form>` — that is the case where the markup has to stand on its own,
 * and `next/form` would buy a client-side navigation that an error page has no
 * use for.
 */
export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-20 sm:px-6">
      <p className="text-sm font-medium uppercase tracking-wide text-muted">404</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">Nothing tracked at that address</h1>
      <p className="mt-2 text-sm text-muted">
        It is not a page in this app, not an asset in the catalogue or the ledger,
        and not one of the markets below. If you arrived from a link with a ticker
        in it, search for the ticker — the ranker matches names and synonyms too,
        so <span className="text-foreground">bullion</span> finds gold.
      </p>

      <form action="/search" method="get" className="mt-6 flex gap-2">
        <input
          type="search"
          name="q"
          autoFocus
          placeholder="Ticker, name or market"
          aria-label="Search assets"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-muted focus-visible:border-accent"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm font-medium hover:border-accent"
        >
          Search
        </button>
      </form>

      <p className="mt-8 text-xs font-semibold uppercase tracking-wide text-muted">Markets</p>
      <nav aria-label="Markets" className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {MARKETS.map((m) => (
          <Link key={m} href={marketHref(m)} className="text-accent underline-offset-2 hover:underline">
            {MARKET_META[m].label}
          </Link>
        ))}
      </nav>

      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-muted">Pages</p>
      <nav aria-label="Elsewhere in the app" className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <Link href="/" className="text-accent underline-offset-2 hover:underline">Overview</Link>
        <Link href="/portfolio" className="text-accent underline-offset-2 hover:underline">Portfolio</Link>
        <Link href="/markets" className="text-accent underline-offset-2 hover:underline">Markets</Link>
        <Link href="/news" className="text-accent underline-offset-2 hover:underline">News</Link>
        <Link href="/transactions" className="text-accent underline-offset-2 hover:underline">Transactions</Link>
      </nav>
    </div>
  );
}
