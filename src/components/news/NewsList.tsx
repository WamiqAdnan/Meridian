import Link from "next/link";
import { fmtAgo } from "@/lib/format";
import { MARKET_META } from "@/lib/markets/types";
import { assetHref } from "@/lib/routes";
import { groupByDay } from "@/lib/news/view";
import type { NewsItem } from "@/lib/news/store";
import type { MatchVia } from "@/lib/news/types";

/**
 * How a link was made, in words.
 *
 * Shown rather than hidden, because the difference between "the publisher filed
 * this under AAPL" and "this sentence contains the word gold" is exactly the
 * difference a reader needs in order to trust the grouping — and the same
 * distinction any insight built on top of it has to respect.
 */
const VIA_LABEL: Record<MatchVia, string> = {
  feed: "filed by the publisher against",
  symbol: "ticker appears in",
  name: "named in",
  alias: "referred to in",
};

/** Matches at or above this read as confident enough to show unqualified. */
const STRONG = 0.7;

function AssetChips({ matches }: { matches: NewsItem["matches"] }) {
  if (matches.length === 0) return null;
  const shown = matches.slice(0, 4);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((m) => (
        <Link
          key={m.assetId}
          href={assetHref(m.assetId)}
          title={`${m.name} — ${VIA_LABEL[m.via]} this article (confidence ${m.score.toFixed(2)})`}
          className={`rounded border px-1.5 py-0.5 text-[11px] tabular-nums transition-colors hover:bg-surface-raised ${
            m.score >= STRONG
              ? "border-line text-foreground"
              : "border-dashed border-line text-muted"
          }`}
        >
          {m.symbol}
        </Link>
      ))}
      {matches.length > shown.length && (
        <span className="text-[11px] text-muted">+{matches.length - shown.length}</span>
      )}
    </span>
  );
}

/**
 * A day-grouped list of headlines.
 *
 * Every row links out to the publisher rather than to a reader page: the app
 * stores a headline and a link, never the article body, and pretending otherwise
 * would be both a copyright problem and a lie about what it holds.
 */
export default function NewsList({
  items,
  emptyLabel = "No headlines yet. Run the news refresh to pull some in.",
}: {
  items: NewsItem[];
  emptyLabel?: string;
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-sm text-muted">
        {emptyLabel}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {groupByDay(items).map((day) => (
        <section key={day.date} aria-labelledby={`news-${day.date}`}>
          <h3
            id={`news-${day.date}`}
            className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted"
          >
            {day.label}
          </h3>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {day.items.map(({ article, matches }) => (
              <li key={article.id} className="px-3 py-3">
                <a
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium hover:underline"
                >
                  {article.title}
                </a>
                {article.summary && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted">{article.summary}</p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  <span>{article.source}</span>
                  <span aria-hidden>·</span>
                  <time
                    dateTime={article.publishedAt.toISOString()}
                    title={article.publishedAt.toLocaleString()}
                  >
                    {fmtAgo(article.publishedAt)}
                  </time>
                  {article.market && (
                    <>
                      <span aria-hidden>·</span>
                      <span>{MARKET_META[article.market].label}</span>
                    </>
                  )}
                  <AssetChips matches={matches} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
