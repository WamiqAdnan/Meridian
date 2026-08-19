import { ChartBlock, ListBlock, PageLoading, SectionHeading } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageLoading title="the markets" width="7xl">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-line p-4">
            <ChartBlock stats={0} />
          </div>
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <SectionHeading />
            <ListBlock rows={5} />
          </div>
        ))}
      </div>
    </PageLoading>
  );
}
