import { PageLoading, SectionHeading, TableBlock } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageLoading title="the replicator">
      <SectionHeading width="w-40" />
      <TableBlock rows={10} cols={6} />
    </PageLoading>
  );
}
