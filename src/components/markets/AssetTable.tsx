import Link from "next/link";
import { fmtCompact, fmtPrice } from "@/lib/format";
import { assetHref } from "@/lib/routes";
import Change from "./Change";
import Sparkline from "./Sparkline";
import type { AssetView } from "@/lib/markets/view";

/**
 * The full asset listing for one market.
 *
 * Every window is shown at once rather than behind the period switcher: this is
 * the screen where the question is "what has this been doing", and a row that
 * rose this week but fell this month says more than either number alone.
 */
export default function AssetTable({ assets }: { assets: AssetView[] }) {
  if (assets.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
        Nothing tracked in this market yet. Run <code className="font-mono">npm run market:backfill</code>.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[52rem] text-sm">
        <caption className="sr-only">Assets with price and performance over several periods</caption>
        <thead className="bg-surface-raised text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Asset</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Price</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">1D</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">1W</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">1M</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">3M</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">YTD</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Volume</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">30d</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {assets.map((a) => (
            <tr key={a.id} className="hover:bg-surface-raised/60">
              <th scope="row" className="px-3 py-2 text-left font-normal">
                <Link href={assetHref(a.id)} className="font-semibold hover:text-accent">
                  {a.symbol}
                </Link>
                <div className="max-w-[16rem] truncate text-xs font-normal text-muted">{a.name}</div>
              </th>
              <td className="px-3 py-2 text-right tabular-nums">{fmtPrice(a.price, a.currency)}</td>
              {(["day", "week", "month", "quarter", "ytd"] as const).map((p) => (
                <td key={p} className="px-3 py-2 text-right">
                  <Change
                    changePct={a.performance.periods[p]?.changePct}
                    change={a.performance.periods[p]?.change}
                    currency={a.currency}
                  />
                </td>
              ))}
              <td className="px-3 py-2 text-right tabular-nums text-xs text-muted">
                {fmtCompact(a.volume)}
              </td>
              <td className="px-3 py-2">
                <div className="flex justify-end">
                  <Sparkline points={a.spark} width={88} height={24} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
