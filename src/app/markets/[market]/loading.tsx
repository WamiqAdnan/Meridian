import { ListBlock, PageLoading, SectionHeading, TableBlock } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageLoading title="the market" width="7xl">
      <TableBlock rows={12} cols={6} />
      <div className="mt-8 grid gap-4 lg:grid-cols-3">
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
