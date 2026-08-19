import { PageLoading, TableBlock } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageLoading title="the ledger">
      <TableBlock rows={12} cols={8} />
    </PageLoading>
  );
}
