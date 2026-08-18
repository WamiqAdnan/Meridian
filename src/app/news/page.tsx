import type { Metadata } from "next";
import Link from "next/link";
import { ingestIfStale } from "@/lib/news/ingest";
import { loadNewsFeed } from "@/lib/news/view";
import { MARKET_META, MARKETS, isMarket, type Market } from "@/lib/markets/types";
import NewsList from "@/components/news/NewsList";
import RefreshNewsButton from "@/components/news/RefreshNewsButton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "News",
  description: "Headlines across every tracked market, matched to the assets they concern.",
};

/** Every market, plus "all" — the filter strip above the feed. */
function MarketFilter({ selected }: { selected: Market | null }) {
  const tab = (href: string, label: string, active: boolean) => (
    <Link
      key={href}
      href={href}
      aria-current={active ? "page" : undefined}
      className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors ${
        active
          ? "bg-surface-raised font-medium text-foreground"
          : "text-muted hover:bg-surface-raised hover:text-foreground"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <nav aria-label="Filter by market" className="flex flex-wrap items-center gap-0.5">
      {tab("/news", "All", selected === null)}
      {MARKETS.map((m) => tab(`/news?market=${m}`, MARKET_META[m].label, selected === m))}
    </nav>
  );
}

/**
 * Every headline the app has pulled in, newest first.
 *
 * The list is deliberately plain: a link, a publisher, a time, and the assets the
 * article was matched to. Nothing here interprets a headline — that is Phase D's
 * job, and doing it implicitly in a feed would be exactly the sort of unlabelled
 * inference the brief rules out.
 */
export default async function NewsPage({
  searchParams,
}: {
  searchParams: Promise<{ market?: string }>;
}) {
  const raw = (await searchParams).market;
  const market = isMarket(raw) ? raw : null;

  await ingestIfStale(market ? { market } : {});
  const items = await loadNewsFeed({ market: market ?? undefined, limit: 60 });

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">News</h1>
          <p className="mt-1 text-sm text-muted">
            {market ? MARKET_META[market].label : "Every market"} · {items.length} headline
            {items.length === 1 ? "" : "s"} · matched to the assets they name
          </p>
        </div>
        <RefreshNewsButton market={market ?? undefined} />
      </header>

      <div className="mb-5">
        <MarketFilter selected={market} />
      </div>

      <NewsList
        items={items}
        emptyLabel={
          market
            ? `Nothing yet for ${MARKET_META[market].label}. Try refreshing, or widen to All.`
            : "No headlines yet. Run npm run news:refresh, or use the button above."
        }
      />
    </div>
  );
}
