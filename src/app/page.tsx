import Link from "next/link";
import { loadPortfolio } from "@/lib/portfolio-view";
import { refreshIfStale } from "@/lib/markets/refresh";
import {
  fmtAgo,
  fmtMoney,
  fmtPct,
  fmtPrice,
  fmtUnits,
  pnlColor,
} from "@/lib/format";
import UploadCard from "@/components/UploadCard";
import AllocationDonut from "@/components/AllocationDonut";
import InvestorSwitcher from "@/components/InvestorSwitcher";
import RefreshMarketsButton from "@/components/markets/RefreshMarketsButton";
import { INVESTORS, toOwnerFilter } from "@/lib/investors";
import { listKnownParsers } from "@/lib/broker-profiles";
import { aiBackendLabel } from "@/lib/ai";
import { DEFAULT_BASE_CURRENCY } from "@/lib/portfolio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The dashboard: what you hold and how to get more of it into the app.
 *
 * Prices now come from the same market pipeline as everything else, rather than
 * the PSX-only cache this page used to own — so a non-PSX position shows a real
 * price here instead of a blank.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string }>;
}) {
  const owner = toOwnerFilter((await searchParams).owner); // null = Together (combined)
  const base = DEFAULT_BASE_CURRENCY;

  await refreshIfStale();

  const [portfolio, parsers] = await Promise.all([
    loadPortfolio({ owner, baseCurrency: base }),
    listKnownParsers(),
  ]);
  const { positions, totals, realized, warnings, pricesFetchedAt } = portfolio;

  const hasHoldings = positions.length > 0;
  const viewLabel = owner ?? "Together";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Dashboard <span className="font-normal text-muted">· {viewLabel}</span>
          </h1>
          <p className="text-sm text-muted">
            Holdings from your statements and manual entries ·{" "}
            <span title={pricesFetchedAt?.toLocaleString() ?? undefined}>
              prices updated {fmtAgo(pricesFetchedAt)}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/portfolio"
            className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface-raised"
          >
            Full portfolio →
          </Link>
          <RefreshMarketsButton />
        </div>
      </header>

      <div className="mb-6">
        <InvestorSwitcher basePath="/" selected={owner} />
      </div>

      {warnings.length > 0 && (
        <div className="mb-4 space-y-1 rounded-xl border border-line bg-surface-raised p-3 text-sm text-muted">
          {warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card
          label={`Invested (${base}, incl. fees)`}
          value={fmtMoney(totals.invested, base)}
          sub={`${totals.positions} position${totals.positions === 1 ? "" : "s"}`}
        />
        <Card label={`Market value (${base})`} value={fmtMoney(totals.marketValue, base)} />
        <Card
          label="Unrealized P&L"
          value={fmtMoney(totals.unrealizedPnl, base)}
          sub={fmtPct(totals.unrealizedPnlPct)}
          color={pnlColor(totals.unrealizedPnl)}
        />
        <Card
          label="Realized P&L"
          value={fmtMoney(totals.realizedTotal, base)}
          color={pnlColor(totals.realizedTotal)}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Holdings</h2>
          {hasHoldings ? (
            <div className="overflow-x-auto rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead className="bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2">Symbol</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-right">Avg cost</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Day</th>
                    <th className="px-3 py-2 text-right">Value ({base})</th>
                    <th className="px-3 py-2 text-right">P&amp;L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {positions.map((p) => (
                    <tr key={p.assetId} className="hover:bg-surface-raised/60">
                      <td className="px-3 py-2">
                        <span className="font-semibold">{p.symbol}</span>
                        <div className="text-xs text-muted">{p.marketLabel}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtUnits(p.qty)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {p.currency ? fmtPrice(p.avgCostInclFees, p.currency) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {p.currency ? fmtPrice(p.price, p.currency) : "—"}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pnlColor(p.dayChangePct)}`}>
                        {fmtPct(p.dayChangePct)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {p.baseValue != null || p.baseCost != null
                          ? fmtMoney(p.baseValue ?? p.baseCost, base)
                          : "—"}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${pnlColor(p.baseUnrealizedPnl)}`}>
                        <div>{p.baseUnrealizedPnl != null ? fmtMoney(p.baseUnrealizedPnl, base) : "—"}</div>
                        <div className="text-xs opacity-80">{fmtPct(p.unrealizedPnlPct)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
              No holdings yet. Upload a broker statement here, or{" "}
              <Link href="/portfolio" className="text-accent underline-offset-2 hover:underline">
                record a trade by hand
              </Link>
              .
            </div>
          )}

          {realized.length > 0 && (
            <div className="mt-6">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
                Realized P&amp;L (from sells)
              </h2>
              <div className="flex flex-wrap gap-2">
                {/* Shown in the asset's own currency — that is the amount that
                    was actually booked. Only the header total is converted. */}
                {realized.map((r) => (
                  <span
                    key={r.assetId}
                    className={`rounded-lg border border-line px-2.5 py-1 text-xs ${pnlColor(r.amount)}`}
                    title={
                      r.baseAmount != null ? `${fmtMoney(r.baseAmount, base)} in ${base}` : undefined
                    }
                  >
                    <b className="text-foreground">{r.symbol}</b>{" "}
                    {r.currency ? fmtMoney(r.amount, r.currency) : r.amount.toFixed(2)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>

        <aside className="space-y-6">
          <div>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Import</h2>
            <UploadCard defaultOwner={owner ?? INVESTORS[0]} learningBackend={aiBackendLabel()} />
            {parsers.length > 0 && (
              <p className="mt-2 text-xs text-muted">
                <span className="font-medium">Brokers we can read:</span>{" "}
                {parsers.map((p, i) => (
                  <span key={p.slug}>
                    {i > 0 && " · "}
                    <span title={p.source === "builtin" ? "Built in" : "Learned from an upload"}>
                      {p.broker}
                      {p.source === "llm" && <span className="text-muted"> (learned)</span>}
                    </span>
                  </span>
                ))}
              </p>
            )}
          </div>
          {hasHoldings && (
            <div>
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
                Allocation
              </h2>
              <div className="rounded-xl border border-line p-4">
                <AllocationDonut
                  data={positions
                    .filter((p) => (p.baseValue ?? p.baseCost) != null)
                    .map((p) => ({ label: p.symbol, value: (p.baseValue ?? p.baseCost)! }))}
                  currency={base}
                />
              </div>
            </div>
          )}
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
    <div className="rounded-xl border border-line p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${color ?? ""}`}>{value}</div>
      {sub && <div className={`text-xs tabular-nums ${color ?? "text-muted"}`}>{sub}</div>}
    </div>
  );
}
