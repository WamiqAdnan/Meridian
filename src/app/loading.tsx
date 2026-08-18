import { ChartBlock, ListBlock, PageLoading, SectionHeading, StatCards } from "@/components/Skeleton";

/**
 * The overview, and the fallback for any route below it without one of its own.
 *
 * This is the page with the most to wait for — a quote refresh, a news ingest, a
 * portfolio build and four loaders — so it is the one where a blank screen was
 * most obviously a blank screen.
 */
export default function Loading() {
  return (
    <PageLoading title="the overview" width="7xl">
      <StatCards />
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionHeading />
          <ListBlock rows={6} />
        </div>
        <div>
          <SectionHeading width="w-20" />
          <ChartBlock stats={0} />
        </div>
      </div>
      <div className="mt-8">
        <SectionHeading width="w-40" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border border-line p-4">
              <ChartBlock stats={0} />
            </div>
          ))}
        </div>
      </div>
    </PageLoading>
  );
}
