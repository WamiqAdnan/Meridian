import { prisma } from "@/lib/db";
import { getPortfolio } from "@/lib/portfolio";
import { refreshPricesIfStale } from "@/lib/psx-prices";
import { fmtRs, fmtRs2, fmtPct, fmtSignedRs, fmtQty, fmtTime, pnlColor } from "@/lib/format";
import UploadCard from "@/components/UploadCard";
import RefreshPricesButton from "@/components/RefreshPricesButton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Best-effort: fetch fresh prices for all held symbols.
  const held = await prisma.transaction.findMany({ select: { security: true }, distinct: ["security"] });
  await refreshPricesIfStale(held.map((h) => h.security));

  const { holdings, totals, realizedBySecurity, warnings, pricesFetchedAt, pricedCount } =
    await getPortfolio();

  const hasHoldings = holdings.length > 0;
  const realizedEntries = Object.entries(realizedBySecurity);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">PSX Portfolio</h1>
          <p className="text-sm text-neutral-500">
            Finqalab holdings · live prices from PSX ·{" "}
            <span title="Time of the most recent cached price">updated {fmtTime(pricesFetchedAt)}</span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <RefreshPricesButton />
        </div>
      </header>

      {warnings.length > 0 && (
        <div className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          {warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      {/* Summary cards */}
      <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card label="Invested (incl. fees)" value={fmtRs(totals.invested)} sub={`${totals.positions} positions`} />
        <Card label="Market value" value={fmtRs(totals.marketValue)} />
        <Card
          label="Unrealized P&L"
          value={fmtSignedRs(totals.unrealizedPnl)}
          sub={fmtPct(totals.unrealizedPnlPct)}
          color={pnlColor(totals.unrealizedPnl)}
        />
        <Card
          label="Realized P&L"
          value={fmtSignedRs(totals.realizedTotal)}
          color={pnlColor(totals.realizedTotal)}
        />
      </section>

      {pricedCount < holdings.length && (
        <div className="mb-4 rounded-lg bg-neutral-100 p-3 text-sm text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
          Live prices unavailable for {holdings.length - pricedCount} of {holdings.length} holdings — showing cost as a fallback. Try “Refresh prices”.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Holdings table */}
        <section className="lg:col-span-2">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Holdings</h2>
          {hasHoldings ? (
            <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
                  <tr>
                    <th className="px-3 py-2">Symbol</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Avg cost</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Day</th>
                    <th className="px-3 py-2 text-right">Value</th>
                    <th className="px-3 py-2 text-right">P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {holdings.map((h) => (
                    <tr key={h.security} className="hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
                      <td className="px-3 py-2 font-semibold">{h.security}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtQty(h.qty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtRs2(h.avgCostInclFees)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtRs2(h.livePrice)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pnlColor(h.dayChangePct)}`}>
                        {fmtPct(h.dayChangePct)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtRs(h.marketValue)}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pnlColor(h.unrealizedPnl)}`}>
                        <div>{fmtSignedRs(h.unrealizedPnl)}</div>
                        <div className="text-xs opacity-80">{fmtPct(h.unrealizedPnlPct)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
              No holdings yet. Upload a Finqalab report to get started →
            </div>
          )}

          {realizedEntries.length > 0 && (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
                Realized P&L (from sells)
              </h2>
              <div className="flex flex-wrap gap-2">
                {realizedEntries.map(([sym, pnl]) => (
                  <span
                    key={sym}
                    className={`rounded-lg border border-neutral-200 px-2.5 py-1 text-xs dark:border-neutral-800 ${pnlColor(pnl)}`}
                  >
                    <b className="text-neutral-700 dark:text-neutral-300">{sym}</b> {fmtSignedRs(pnl)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Sidebar */}
        <aside className="space-y-6">
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Import</h2>
            <UploadCard />
          </div>
        </aside>
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${color ?? ""}`}>{value}</div>
      {sub && <div className={`text-xs tabular-nums ${color ?? "text-neutral-500"}`}>{sub}</div>}
    </div>
  );
}
