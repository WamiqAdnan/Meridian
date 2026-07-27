"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fmtRs, fmtRs2, fmtQty } from "@/lib/format";
import { INVESTORS } from "@/lib/investors";
import OwnerSelect from "@/components/OwnerSelect";
import DeleteTradeButton from "@/components/DeleteTradeButton";

export interface LedgerRow {
  id: number;
  tradeDate: string;
  owner: string;
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
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const allSelected = trades.length > 0 && selected.size === trades.length;

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(trades.map((t) => t.id)));
  }
  function clear() {
    setSelected(new Set());
  }

  async function reassign(owner: string) {
    setError(null);
    const ids = [...selected];
    const res = await fetch("/api/transactions/reassign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, owner }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error ?? "Reassign failed");
      return;
    }
    clear();
    startTransition(() => router.refresh());
  }

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
            <tr>
              <th className="px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="align-middle"
                />
              </th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Owner</th>
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
            {trades.map((t) => {
              const checked = selected.has(t.id);
              return (
                <tr
                  key={t.id}
                  className={
                    checked
                      ? "bg-blue-50 dark:bg-blue-950/30"
                      : "hover:bg-neutral-50 dark:hover:bg-neutral-900/50"
                  }
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`Select trade ${t.tradeNo}`}
                      checked={checked}
                      onChange={() => toggle(t.id)}
                      className="align-middle"
                    />
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums text-neutral-500">{t.tradeDate}</td>
                  <td className="px-3 py-2">
                    <OwnerSelect id={t.id} owner={t.owner} />
                  </td>
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
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-4 z-10 flex justify-center px-4">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-neutral-300 bg-white/95 px-4 py-2.5 text-sm shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95">
            <span className="font-medium">
              {selected.size} selected
            </span>
            <span className="text-neutral-500">Reassign to</span>
            {INVESTORS.map((name) => (
              <button
                key={name}
                type="button"
                disabled={pending}
                onClick={() => reassign(name)}
                className="rounded-lg bg-neutral-900 px-3 py-1 font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                {name}
              </button>
            ))}
            {error && <span className="text-rose-600 dark:text-rose-400">{error}</span>}
            <button
              type="button"
              onClick={clear}
              className="ml-1 rounded-lg border border-neutral-300 px-3 py-1 font-medium text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </>
  );
}
