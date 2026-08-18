import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { loadPortfolio } from "@/lib/portfolio-view";
import { toBaseCurrency, PNL_PERIODS, type PnlPeriod } from "@/lib/portfolio";
import { refreshIfStale } from "@/lib/markets/refresh";
import { toOwnerFilter, INVESTORS } from "@/lib/investors";
import { isMarket, type Market } from "@/lib/markets/types";
import {
  fmtAgo,
  fmtMoney,
  fmtMove,
  fmtPct,
  fmtPrice,
  fmtUnits,
  fmtWeight,
  pnlColor,
} from "@/lib/format";
import { listKnownParsers } from "@/lib/broker-profiles";
import { aiBackendLabel } from "@/lib/ai";
import { assetHref } from "@/lib/routes";
import AllocationDonut from "@/components/AllocationDonut";
import InvestorSwitcher from "@/components/InvestorSwitcher";
import UploadCard from "@/components/UploadCard";
import BaseCurrencyTabs from "@/components/BaseCurrencyTabs";
import AddTradeForm, { type AssetOption } from "@/components/AddTradeForm";
import RefreshMarketsButton from "@/components/markets/RefreshMarketsButton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Portfolio",
  description: "Every position you hold, across every market, in one currency.",
};

const PERIOD_LABEL: Record<PnlPeriod, string> = {
  day: "Today",
  week: "This week",
  month: "This month",
};

/**
 * The whole book, across every market, totalled in one currency.
 *
 * The numbers come from `buildPortfolio`; this page only arranges them. Note the
 * two different currencies on screen at once and why: a position is quoted and
 * costed in its own currency (a US holding is in dollars, and rounding it into
 * rupees to display it would be a lie about what you own), while every *total*
 * is converted, because a sum across currencies is otherwise meaningless.
 */
export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ owner?: string; base?: string }>;
}) {
  const params = await searchParams;
  const owner = toOwnerFilter(params.owner);
  const base = toBaseCurrency(params.base);

  await refreshIfStale();

  const [portfolio, assetRows, parsers] = await Promise.all([
    loadPortfolio({ owner, baseCurrency: base }),
    prisma.asset.findMany({
      where: { active: true },
      orderBy: [{ market: "asc" }, { symbol: "asc" }],
      select: { id: true, market: true, symbol: true, name: true, currency: true },
    }),
    listKnownParsers(),
  ]);

  const { positions, totals, byMarket, byAsset, best, worst, warnings, pricesFetchedAt } = portfolio;

  const assetOptions: AssetOption[] = assetRows
    .filter((a): a is typeof a & { market: Market } => isMarket(a.market))
    .map((a) => ({
      id: a.id,
      market: a.market,
      symbol: a.symbol,
      name: a.name,
      currency: a.currency,
    }));

  const hasPositions = positions.length > 0;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Portfolio <span className="font-normal text-muted">· {owner ?? "Together"}</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            Every position across every market, totalled in {base} ·{" "}
            <span title={pricesFetchedAt?.toLocaleString() ?? undefined}>
              prices updated {fmtAgo(pricesFetchedAt)}
            </span>
          </p>
        </div>
        <RefreshMarketsButton />
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <InvestorSwitcher basePath="/portfolio" selected={owner} />
        <BaseCurrencyTabs basePath="/portfolio" selected={base} extraParams={{ owner: owner ?? undefined }} />
      </div>

      {warnings.length > 0 && (
        <div className="mb-4 space-y-1 rounded-xl border border-line bg-surface-raised p-3 text-sm text-muted">
          {warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card
          label={`Invested (${base})`}
          value={fmtMoney(totals.invested, base)}
          sub={`${totals.positions} position${totals.positions === 1 ? "" : "s"} · ${byMarket.length} market${byMarket.length === 1 ? "" : "s"}`}
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
          sub="booked from sells"
          color={pnlColor(totals.realizedTotal)}
        />
      </section>

      {/* Market movement on the positions held now — see the note in portfolio.ts. */}
      <section className="mb-6 grid grid-cols-3 gap-3">
        {PNL_PERIODS.map((p) => (
          <Card
            key={p}
            label={PERIOD_LABEL[p]}
            value={totals.periodPnl[p] == null ? "—" : fmtMoney(totals.periodPnl[p], base)}
            sub={totals.periodPnl[p] == null ? "insufficient history" : "market movement"}
            color={pnlColor(totals.periodPnl[p])}
          />
        ))}
      </section>

      {!hasPositions ? (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="rounded-xl border border-dashed border-line p-10 text-center lg:col-span-2">
            <p className="text-sm font-medium">No positions yet.</p>
            <p className="mt-1 text-sm text-muted">
              Record a trade on the right, or drop in a broker statement below it.
            </p>
          </div>
          <aside className="space-y-6">
            <AddTradeForm assets={assetOptions} defaultOwner={owner ?? INVESTORS[0]} />
            <ImportPanel owner={owner} parsers={parsers} />
          </aside>
        </div>
      ) : (
        <>
          {(best || worst) && (
            <section className="mb-6 grid gap-3 sm:grid-cols-2">
              {best && <Performer position={best} label="Best performer" />}
              {worst && <Performer position={worst} label="Worst performer" />}
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-3">
            <section className="lg:col-span-2">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
                Holdings
              </h2>
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full text-sm">
                  <thead className="bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-2">Asset</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Avg cost</th>
                      <th className="px-3 py-2 text-right">Price</th>
                      <th className="px-3 py-2 text-right">Day</th>
                      <th className="px-3 py-2 text-right">Value ({base})</th>
                      <th className="px-3 py-2 text-right">Weight</th>
                      <th className="px-3 py-2 text-right">P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {positions.map((p) => (
                      <tr key={p.assetId} className="hover:bg-surface-raised/60">
                        <td className="px-3 py-2">
                          <Link href={assetHref(p.assetId)} className="font-semibold hover:text-accent">
                            {p.symbol}
                          </Link>
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
                          {p.currency ? fmtMove(p.dayChangePct, null, p.currency) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {p.baseValue != null || p.baseCost != null
                            ? fmtMoney(p.baseValue ?? p.baseCost, base)
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted">
                          {fmtWeight(p.weightPct)}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${pnlColor(p.baseUnrealizedPnl)}`}>
                          <div>
                            {p.baseUnrealizedPnl != null ? fmtMoney(p.baseUnrealizedPnl, base) : "—"}
                          </div>
                          <div className="text-xs opacity-80">{fmtPct(p.unrealizedPnlPct)}</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {byMarket.length > 0 && (
                <div className="mt-6">
                  <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
                    Allocation by market
                  </h2>
                  <div className="space-y-2 rounded-xl border border-line p-4">
                    {byMarket.map((m) => (
                      <div key={m.key} className="flex items-center gap-3">
                        <div className="w-32 shrink-0 truncate text-sm">{m.label}</div>
                        <div
                          className="h-2 flex-1 overflow-hidden rounded-full bg-surface-raised"
                          role="presentation"
                        >
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${Math.max(m.weightPct, 0.5)}%` }}
                          />
                        </div>
                        <div className="w-16 shrink-0 text-right text-xs tabular-nums text-muted">
                          {fmtWeight(m.weightPct)}
                        </div>
                        <div className="w-28 shrink-0 text-right text-sm tabular-nums">
                          {fmtMoney(m.value, base)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <aside className="space-y-6">
              <AddTradeForm assets={assetOptions} defaultOwner={owner ?? INVESTORS[0]} />

              <ImportPanel owner={owner} parsers={parsers} />

              {byAsset.length > 0 && (
                <div>
                  <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">
                    Allocation by asset
                  </h2>
                  <div className="rounded-xl border border-line p-4">
                    <AllocationDonut data={byAsset} currency={base} />
                  </div>
                </div>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Statement import.
 *
 * Lives here rather than on the overview because it is a *task*, not a status:
 * getting trades into the ledger belongs next to the other way of doing that, the
 * manual trade form above it. The overview summarises what is already in.
 */
function ImportPanel({
  owner,
  parsers,
}: {
  owner: string | null;
  parsers: Awaited<ReturnType<typeof listKnownParsers>>;
}) {
  return (
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
  );
}

function Performer({
  position,
  label,
}: {
  position: NonNullable<Awaited<ReturnType<typeof loadPortfolio>>["best"]>;
  label: string;
}) {
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-lg font-bold">{position.symbol}</span>
        <span className="text-xs text-muted">{position.marketLabel}</span>
        <span className={`ml-auto text-lg font-bold tabular-nums ${pnlColor(position.unrealizedPnlPct)}`}>
          {fmtPct(position.unrealizedPnlPct)}
        </span>
      </div>
      <div className="mt-0.5 text-xs text-muted">
        {position.currency
          ? `${fmtPrice(position.avgCostInclFees, position.currency)} → ${fmtPrice(position.price, position.currency)}`
          : "no price"}
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
