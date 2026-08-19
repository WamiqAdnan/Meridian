import { PageLoading, SectionHeading, StatCards, TableBlock } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageLoading title="the portfolio" width="7xl">
      <StatCards />
      <div className="mt-6">
        <SectionHeading width="w-24" />
        <TableBlock rows={10} cols={7} />
      </div>
    </PageLoading>
  );
}
