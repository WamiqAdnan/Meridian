import { ListBlock, PageLoading } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageLoading title="search results" width="4xl">
      <ListBlock rows={8} />
    </PageLoading>
  );
}
