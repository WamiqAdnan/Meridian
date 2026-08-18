import { ChartBlock, ListBlock, PageLoading, SectionHeading, TableBlock } from "@/components/Skeleton";

/**
 * The asset page waits on a refresh, a news ingest, the bars and the portfolio,
 * and its chart is the one block on the site tall enough that its absence moves
 * everything below it. Worth claiming the space up front.
 */
export default function Loading() {
  return (
    <PageLoading title="the asset">
      <ChartBlock />
      <div className="mt-8 grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SectionHeading width="w-24" />
          <TableBlock rows={5} cols={5} />
        </div>
        <div>
          <SectionHeading width="w-28" />
          <ListBlock rows={5} height="h-4" />
        </div>
      </div>
    </PageLoading>
  );
}
