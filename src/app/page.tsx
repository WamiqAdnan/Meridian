import { prisma } from "@/lib/db";
import UploadCard from "@/components/UploadCard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const tradeCount = await prisma.transaction.count();

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">PSX Portfolio</h1>
      <p className="mt-1 mb-6 text-sm text-neutral-500">
        {tradeCount} trade{tradeCount === 1 ? "" : "s"} in the ledger.
      </p>
      <UploadCard />
    </main>
  );
}
