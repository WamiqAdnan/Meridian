import Link from "next/link";
import { prisma } from "@/lib/db";
import { toOwnerFilter } from "@/lib/investors";
import InvestorSwitcher from "@/components/InvestorSwitcher";
import LedgerTable, { type LedgerRow } from "@/components/LedgerTable";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string }>;
}) {
  const owner = toOwnerFilter((await searchParams).owner);
  const rows = await prisma.transaction.findMany({
    where: owner ? { owner } : undefined,
    orderBy: [{ tradeDate: "desc" }, { tradeNo: "desc" }],
  });

  // Serialize to the plain shape the client table needs (drops Date fields).
  const trades: LedgerRow[] = rows.map((t) => ({
    id: t.id,
    tradeDate: t.tradeDate,
    owner: t.owner,
    security: t.security,
    side: t.side,
    qty: t.qty,
    rate: t.rate,
    grossAmount: t.grossAmount,
    brokerage: t.brokerage,
    cvt: t.cvt,
    netAmount: t.netAmount,
    tradeNo: t.tradeNo,
  }));

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Transactions</h1>
          <p className="text-sm text-neutral-500">
            {trades.length} trade{trades.length === 1 ? "" : "s"} · the ledger holdings are derived from.
            Tick rows to reassign several at once, change a single <b>owner</b> inline, or delete a row —
            holdings recompute automatically.
          </p>
        </div>
        <Link
          href="/"
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          ← Dashboard
        </Link>
      </header>

      <div className="mb-6">
        <InvestorSwitcher basePath="/transactions" selected={owner} />
      </div>

      {trades.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
          No trades yet. Import a Finqalab report from the dashboard.
        </div>
      ) : (
        <LedgerTable trades={trades} />
      )}
    </div>
  );
}
