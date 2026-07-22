"use client";

import { fmtRs, fmtRs2, fmtQty } from "@/lib/format";
import DeleteTradeButton from "@/components/DeleteTradeButton";

export interface LedgerRow {
  id: number;
  tradeDate: string;
  security: string;
  side: string;
  qty: number;
  rate: number;
  grossAmount: number;
  brokerage: number;
  cvt: number;
  netAmount: number;
  tradeNo: string;
}

export default function LedgerTable({ trades }: { trades: LedgerRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
      <table className="w-full text-sm">
        <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
          <tr>
            <th className="px-3 py-2">Date</th>
            <th className="px-3 py-2">Symbol</th>
            <th className="px-3 py-2">Side</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-right">Rate</th>
            <th className="px-3 py-2 text-right">Gross</th>
            <th className="px-3 py-2 text-right">Brokerage</th>
            <th className="px-3 py-2 text-right">CVT</th>
            <th className="px-3 py-2 text-right">Net</th>
            <th className="px-3 py-2 text-right">Trade&nbsp;#</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {trades.map((t) => (
            <tr key={t.id} className="hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
              <td className="whitespace-nowrap px-3 py-2 tabular-nums text-neutral-500">{t.tradeDate}</td>
              <td className="px-3 py-2 font-semibold">{t.security}</td>
              <td className="px-3 py-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                    t.side === "BUY"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
                      : "bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400"
                  }`}
                >
                  {t.side}
                </span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtQty(t.qty)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtRs2(t.rate)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtRs(t.grossAmount)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtRs2(t.brokerage)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtRs2(t.cvt)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtRs(t.netAmount)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-neutral-400">{t.tradeNo}</td>
              <td className="px-3 py-2 text-right">
                <DeleteTradeButton id={t.id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
