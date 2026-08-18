/**
 * Loading skeletons, shared by every `loading.tsx`.
 *
 * Every page in this app is `force-dynamic`, and several do real work before
 * they can paint anything — the overview alone awaits a quote refresh, a news
 * ingest, a portfolio build and four loaders. Until now that time was a blank
 * screen holding the previous page.
 *
 * Two rules hold everything here together.
 *
 * **A skeleton claims a shape, not content.** Each one mirrors the real page's
 * container width, heading, and the grid beneath it, so the swap moves nothing.
 * A skeleton that guesses wrong is worse than a spinner: it teaches the eye a
 * layout and then takes it away.
 *
 * **The shapes are decoration; the announcement is the content.** Screen readers
 * get one polite "Loading …" from `PageLoading` and nothing else — a dozen
 * `aria-hidden="false"` grey rectangles would be a dozen meaningless stops. The
 * pulse is suppressed under `prefers-reduced-motion` in `globals.css`.
 */

const CONTAINER = {
  "4xl": "max-w-4xl",
  "6xl": "max-w-6xl",
  "7xl": "max-w-7xl",
} as const;

/** One grey block. Sized entirely by the caller. */
export function Shimmer({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-surface-raised ${className}`} />;
}

/**
 * The page frame: the same container, heading block and status announcement on
 * every route, so only the body below differs.
 */
export function PageLoading({
  title,
  width = "6xl",
  children,
}: {
  /** Named in the announcement — "Loading the portfolio". */
  title: string;
  /**
   * Match the page's own container. Written out in full rather than
   * interpolated, because Tailwind only ships a class it can see in the source.
   */
  width?: keyof typeof CONTAINER;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`mx-auto w-full ${CONTAINER[width]} px-4 py-8 sm:px-6`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="sr-only">Loading {title}…</span>
      <div aria-hidden className="mb-5">
        <Shimmer className="h-8 w-56" />
        <Shimmer className="mt-2 h-4 w-80 max-w-full" />
      </div>
      <div aria-hidden>{children}</div>
    </div>
  );
}

/** The four-across summary tiles that head the overview and the portfolio. */
export function StatCards({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-xl border border-line p-4">
          <Shimmer className="h-3 w-24" />
          <Shimmer className="mt-2 h-6 w-32" />
          <Shimmer className="mt-1.5 h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

/** A bordered list of rows — holdings, movers, headlines, search hits. */
export function ListBlock({ rows = 5, height = "h-5" }: { rows?: number; height?: string }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-center justify-between gap-3 px-3 py-2.5">
          <Shimmer className={`${height} w-1/3`} />
          <Shimmer className={`${height} w-20`} />
        </li>
      ))}
    </ul>
  );
}

/** A chart card: the plot area, then the stat strip beneath it. */
export function ChartBlock({ stats = 5 }: { stats?: number }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <Shimmer className="h-48 w-full" />
      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-5">
        {Array.from({ length: stats }, (_, i) => (
          <div key={i}>
            <Shimmer className="h-3 w-16" />
            <Shimmer className="mt-1 h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A header row plus body rows, for the pages that lead with a table. */
export function TableBlock({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="flex gap-3 bg-surface-raised px-3 py-2.5">
        {Array.from({ length: cols }, (_, i) => (
          <Shimmer key={i} className="h-3 flex-1" />
        ))}
      </div>
      <div className="divide-y divide-line">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex gap-3 px-3 py-2.5">
            {Array.from({ length: cols }, (_, c) => (
              <Shimmer key={c} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The uppercase section label the real pages put above each block. */
export function SectionHeading({ width = "w-32" }: { width?: string }) {
  return <Shimmer className={`mb-3 h-3 ${width}`} />;
}
