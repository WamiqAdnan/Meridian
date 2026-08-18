import { ListBlock, PageLoading } from "@/components/Skeleton";

export default function Loading() {
  return (
    <PageLoading title="the news" width="4xl">
      <ListBlock rows={10} height="h-4" />
    </PageLoading>
  );
}
