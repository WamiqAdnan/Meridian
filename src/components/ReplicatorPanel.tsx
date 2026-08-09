"use client";

import { useMemo, useRef, useState } from "react";
import { parsePsxTable } from "@/lib/parse-psx-table";
import {
  INDEX_OPTIONS,
  type IndexCode,
  type IndexConstituent,
  type IndexSnapshot,
} from "@/lib/psx-index";
import {
  DEFAULT_FEE_SCHEDULE,
  planReplication,
  type Constituent,
  type FeeSchedule,
  type PlanRow,
} from "@/lib/replicator";
import { fmtRs, fmtRs2, fmtWeight, fmtQty, fmtTime } from "@/lib/format";

/** How many names to take by default — a compromise between tracking and per-trade fees. */
const DEFAULT_TOP_N = 16;

type SortKey = "weight" | "symbol" | "price";
type Source = "index" | "paste";

/** A candidate row, once its price has been resolved from the source or a cached quote. */
interface BasketRow extends IndexConstituent {
  resolvedPrice: number | null;
  stalePrice: boolean;
}

export default function ReplicatorPanel({
  heldSymbols,
  fallbackPrices,
  initialSnapshot,
  initialError,
}: {
  heldSymbols: string[];
  fallbackPrices: Record<string, number>;
  initialSnapshot: IndexSnapshot | null;
  initialError: string | null;
}) {
  const [source, setSource] = useState<Source>("index");
  const [indexCode, setIndexCode] = useState<IndexCode>(
    initialSnapshot?.code ?? INDEX_OPTIONS[1].code,
  );
  const [snapshot, setSnapshot] = useState<IndexSnapshot | null>(initialSnapshot);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(initialError);

  const [paste, setPaste] = useState("");
  const [topNText, setTopNText] = useState(String(DEFAULT_TOP_N));
  const [sort, setSort] = useState<SortKey>("weight");
  const [deselected, setDeselected] = useState<Set<string>>(() =>
    outsideTopN(initialSnapshot?.rows ?? [], DEFAULT_TOP_N),
  );

  const [amountText, setAmountText] = useState("");
  const [isNewAccount, setIsNewAccount] = useState(false);
  const [fees, setFees] = useState<FeeSchedule>(DEFAULT_FEE_SCHEDULE);
  const [showFees, setShowFees] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const buyListRef = useRef<HTMLPreElement>(null);

  const parsedPaste = useMemo(() => parsePsxTable(paste), [paste]);

  // Both sources reduce to the same shape. A row with no price falls back to the last
  // quote we cached for it, flagged stale — we never invent a price.
  const basket = useMemo<BasketRow[]>(() => {
    const rows: IndexConstituent[] =
      source === "index" ? (snapshot?.rows ?? []) : parsedPaste.rows;
    return rows.map((r) => {
      const fallback = r.price == null ? fallbackPrices[r.baseSymbol] : undefined;
      return {
        ...r,
        resolvedPrice: r.price ?? fallback ?? null,
        stalePrice: r.price == null && fallback != null,
      };
    });
  }, [source, snapshot, parsedPaste.rows, fallbackPrices]);

  const usable = useMemo(
    () => basket.filter((r) => r.resolvedPrice != null && r.weight != null),
    [basket],
  );
  const unusable = useMemo(
    () => basket.filter((r) => r.resolvedPrice == null || r.weight == null),
    [basket],
  );
  const selected = useMemo(
    () => usable.filter((r) => !deselected.has(r.symbol)),
    [usable, deselected],
  );
  const selectedWeight = selected.reduce((s, r) => s + (r.weight ?? 0), 0);
  const sourceWeight = basket.reduce((s, r) => s + (r.weight ?? 0), 0);

  // Anything you hold that this basket doesn't contain — the truncated-paste trap, and
  // a reminder that a held name may simply not be in the index you picked.
  const missingHeld = useMemo(() => {
    if (basket.length === 0) return [];
    const present = new Set(basket.map((r) => r.baseSymbol));
    return heldSymbols.filter((s) => !present.has(s));
  }, [basket, heldSymbols]);

  const amount = Number(amountText.replace(/[^0-9.]/g, ""));
  const hasAmount = amountText.trim() !== "" && Number.isFinite(amount) && amount > 0;

  const result = useMemo(() => {
    if (!hasAmount || selected.length === 0) return null;
    const constituents: Constituent[] = selected.map((r) => ({
      symbol: r.symbol,
      name: r.name,
      price: r.resolvedPrice as number,
      weight: r.weight as number,
      stalePrice: r.stalePrice,
    }));
    return planReplication({ amount, constituents, isNewAccount, feeSchedule: fees });
  }, [hasAmount, amount, selected, isNewAccount, fees]);

  const plan = result?.ok ? result : null;
  // The buy list follows the chosen sort, so heaviest-first ordering carries through
  // to the tickets you actually punch in.
  const orderedPlanRows = useMemo(
    () => (plan ? sortPlanRows(plan.rows, sort) : []),
    [plan, sort],
  );
  const buyListText = orderedPlanRows
    .filter((r) => r.shares > 0)
    .map((r) => `${r.symbol.padEnd(10)}${r.shares}`)
    .join("\n");

  async function loadIndex(code: IndexCode, fresh = false) {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await fetch(`/api/index?code=${code}${fresh ? "&fresh=1" : ""}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load that index.");
      setSnapshot(data as IndexSnapshot);
      // Re-apply Top N to the new constituent list rather than stranding old ticks.
      setDeselected(outsideTopN((data as IndexSnapshot).rows, parseTopN(topNText)));
    } catch (e) {
      setFetchError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function changeIndex(code: IndexCode) {
    setIndexCode(code);
    setSource("index");
    void loadIndex(code);
  }

  /**
   * Switching source swaps the whole candidate list, so Top N has to be re-applied
   * against the new rows — otherwise the box says 16 while a different count is ticked.
   */
  function changeSource(next: Source) {
    setSource(next);
    const rows = (next === "index" ? (snapshot?.rows ?? []) : parsedPaste.rows).filter(
      (r) => r.price != null && r.weight != null,
    );
    setDeselected(outsideTopN(rows, parseTopN(topNText)));
  }

  function changePaste(text: string) {
    setPaste(text);
    const rows = parsePsxTable(text).rows.filter((r) => r.price != null && r.weight != null);
    setDeselected(outsideTopN(rows, parseTopN(topNText)));
  }

  function changeTopN(text: string) {
    setTopNText(text);
    setDeselected(outsideTopN(usable, parseTopN(text)));
  }

  function keepOnly(symbols: Set<string>) {
    setDeselected(new Set(usable.filter((r) => !symbols.has(r.symbol)).map((r) => r.symbol)));
  }

  function toggle(symbol: string) {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });
  }

  function selectHoldings() {
    const held = new Set(heldSymbols);
    keepOnly(new Set(usable.filter((r) => held.has(r.baseSymbol)).map((r) => r.symbol)));
  }

  async function copyBuyList() {
    try {
      await navigator.clipboard.writeText(buyListText);
      setCopied("done");
    } catch {
      // Clipboard access can be refused (unfocused document, insecure origin).
      // Select the list instead so ⌘C still works rather than failing silently.
      const node = buyListRef.current;
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      setCopied("failed");
    }
    setTimeout(() => setCopied("idle"), 2000);
  }

  const sortedBasket = useMemo(() => sortBasket(usable, sort), [usable, sort]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* ---------- Inputs ---------- */}
      <div className="space-y-6">
        <section>
          <SectionHeading>1 · Pick the index</SectionHeading>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={indexCode}
              onChange={(e) => changeIndex(e.target.value as IndexCode)}
              disabled={loading}
              className="rounded-lg border border-neutral-300 bg-transparent px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:opacity-50 dark:border-neutral-700"
            >
              {INDEX_OPTIONS.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => loadIndex(indexCode, true)}
              disabled={loading}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Fetching…" : "↻ Refresh"}
            </button>
            <button
              onClick={() => changeSource(source === "index" ? "paste" : "index")}
              className="text-xs text-neutral-500 underline decoration-dotted hover:text-neutral-700 dark:hover:text-neutral-300"
            >
              {source === "index" ? "or paste a table" : "back to live fetch"}
            </button>
          </div>

          {source === "index" && snapshot && (
            <p className="mt-1 text-xs text-neutral-500">
              {snapshot.rows.length} names · {fmtWeight(snapshot.totalWeight)} of the index ·
              prices as of {fmtTime(snapshot.fetchedAt)}
            </p>
          )}
          {fetchError && <Notice tone="amber">{fetchError}</Notice>}

          {source === "paste" && (
            <div className="mt-2">
              <textarea
                value={paste}
                onChange={(e) => changePaste(e.target.value)}
                spellCheck={false}
                rows={7}
                // One row per line — soft-wrapping a DPS row across three lines makes it
                // impossible to check the paste by eye.
                wrap="off"
                placeholder={
                  "Paste rows from dps.psx.com.pk → Indices, e.g.\nFFC  Fauji Fertilizer Company Limited  543.22  545.00  1.78  0.33%  11.89%  93.09  940,148  566  308,331\n\nOr one line per name: FFC 545.00 11.89"
                }
                className="w-full overflow-x-auto rounded-xl border border-neutral-300 bg-transparent p-3 font-mono text-xs leading-relaxed placeholder:text-neutral-400 focus:border-blue-500 focus:outline-none dark:border-neutral-700"
              />
              {basket.length > 0 && (
                <p className="mt-1 text-xs text-neutral-500">
                  {usable.length} row{usable.length === 1 ? "" : "s"} read ·{" "}
                  {fmtWeight(sourceWeight)} of the index
                </p>
              )}
              {parsedPaste.skipped.length > 0 && (
                <Notice tone="amber">
                  {parsedPaste.skipped.length} line{parsedPaste.skipped.length === 1 ? "" : "s"}{" "}
                  skipped:
                  <ul className="mt-1 space-y-0.5">
                    {parsedPaste.skipped.slice(0, 4).map((s, i) => (
                      <li key={i} className="font-mono text-[11px]">
                        {s.line} — {s.reason}
                      </li>
                    ))}
                  </ul>
                </Notice>
              )}
            </div>
          )}

          {unusable.length > 0 && (
            <Notice tone="amber">
              No usable price or weight for {unusable.map((r) => r.symbol).join(", ")} — left out of
              the weighting.
            </Notice>
          )}
          {missingHeld.length > 0 && (
            <Notice tone="neutral">
              In your ledger but not in this {source === "index" ? "index" : "paste"}:{" "}
              <b>{missingHeld.join(", ")}</b>.
            </Notice>
          )}
        </section>

        {usable.length > 0 && (
          <section>
            <SectionHeading>2 · How many names</SectionHeading>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-sm">
                Top
                <input
                  value={topNText}
                  onChange={(e) => changeTopN(e.target.value)}
                  inputMode="numeric"
                  className="w-16 rounded-lg border border-neutral-300 bg-transparent px-2 py-1 text-sm tabular-nums focus:border-blue-500 focus:outline-none dark:border-neutral-700"
                />
                <span className="text-neutral-500">by weight</span>
              </label>
              <label className="flex items-center gap-1.5 text-sm text-neutral-500">
                Sort
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  className="rounded-lg border border-neutral-300 bg-transparent px-2 py-1 text-sm focus:border-blue-500 focus:outline-none dark:border-neutral-700"
                >
                  <option value="weight">Weight</option>
                  <option value="symbol">Symbol</option>
                  <option value="price">Price</option>
                </select>
              </label>
              <QuickButton onClick={selectHoldings} disabled={heldSymbols.length === 0}>
                My holdings
              </QuickButton>
              <QuickButton onClick={() => setDeselected(new Set())}>All</QuickButton>
            </div>
            <p className="mb-2 text-xs text-neutral-500">
              {selected.length} of {usable.length} ticked · {fmtWeight(selectedWeight)} of the index
            </p>
            <div className="max-h-80 overflow-y-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {sortedBasket.map((r) => (
                    <tr key={r.symbol} className="hover:bg-neutral-50 dark:hover:bg-neutral-900/50">
                      <td className="w-8 pl-3">
                        <input
                          type="checkbox"
                          checked={!deselected.has(r.symbol)}
                          onChange={() => toggle(r.symbol)}
                          aria-label={r.symbol}
                        />
                      </td>
                      <td className="py-2 font-semibold">
                        {r.symbol}
                        {r.stalePrice && <span title="price reused from an earlier quote">*</span>}
                      </td>
                      <td className="hidden max-w-[16rem] truncate py-2 text-xs text-neutral-500 sm:table-cell">
                        {r.name}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {fmtRs2(r.resolvedPrice)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-neutral-500">
                        {fmtWeight(r.weight)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section>
          <SectionHeading>3 · Amount to invest</SectionHeading>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center rounded-lg border border-neutral-300 focus-within:border-blue-500 dark:border-neutral-700">
              <span className="pl-3 text-sm text-neutral-500">Rs</span>
              <input
                value={amountText}
                onChange={(e) => setAmountText(e.target.value)}
                inputMode="numeric"
                placeholder="300,000"
                className="w-36 bg-transparent px-2 py-1.5 text-sm tabular-nums focus:outline-none"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isNewAccount}
                onChange={(e) => setIsNewAccount(e.target.checked)}
              />
              New account{" "}
              <span className="text-xs text-neutral-500">
                (adds {fmtRs2(fees.setupOneTime + fees.setupAnnual)} setup)
              </span>
            </label>
          </div>

          <button
            onClick={() => setShowFees((v) => !v)}
            className="mt-3 text-xs text-neutral-500 underline decoration-dotted hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            {showFees ? "Hide" : "Show"} fee schedule
          </button>
          {showFees && (
            <div className="mt-2 rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <FeeField label="Commission %" value={fees.commissionPct} onChange={(v) => setFees({ ...fees, commissionPct: v })} />
                <FeeField label="Per-share (cheap)" value={fees.smallPerShare} onChange={(v) => setFees({ ...fees, smallPerShare: v })} />
                <FeeField label="Cheap below Rs" value={fees.priceThreshold} onChange={(v) => setFees({ ...fees, priceThreshold: v })} />
                <FeeField label="CDC txn %" value={fees.cdcTxnPct} onChange={(v) => setFees({ ...fees, cdcTxnPct: v })} />
                <FeeField label="CDC min / trade" value={fees.cdcTxnMin} onChange={(v) => setFees({ ...fees, cdcTxnMin: v })} />
                <FeeField label="Setup one-time" value={fees.setupOneTime} onChange={(v) => setFees({ ...fees, setupOneTime: v })} />
                <FeeField label="Setup annual" value={fees.setupAnnual} onChange={(v) => setFees({ ...fees, setupAnnual: v })} />
              </div>
              <p className="mt-2 text-xs text-neutral-500">
                Defaults follow one broker&apos;s schedule — override to match yours. Not charged at buy
                time and so not included: CDC custody (0.005625%/month of holding value), annual UIN
                renewal, and on a later sell, commission again plus capital-gains tax.
              </p>
            </div>
          )}
        </section>
      </div>

      {/* ---------- Results ---------- */}
      <div className="space-y-4">
        <SectionHeading>Buy list</SectionHeading>

        {!plan && (
          <div className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700">
            {result && !result.ok ? (
              <span className="text-amber-700 dark:text-amber-400">{result.error}</span>
            ) : usable.length === 0 ? (
              "Pick an index to start."
            ) : selected.length === 0 ? (
              "Tick at least one symbol."
            ) : (
              "Enter an amount to see the buy list."
            )}
          </div>
        )}

        {plan && (
          <>
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800">
              <div className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <span className="text-xs text-neutral-500">
                  {plan.buyList.length} order{plan.buyList.length === 1 ? "" : "s"}
                </span>
                <button
                  onClick={copyBuyList}
                  disabled={plan.buyList.length === 0}
                  className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                >
                  {copied === "done" ? "Copied" : copied === "failed" ? "Selected — ⌘C" : "Copy"}
                </button>
              </div>
              <pre
                ref={buyListRef}
                className="max-h-72 overflow-auto px-3 py-2 font-mono text-sm leading-6"
              >
                {buyListText || "nothing buyable at this amount"}
              </pre>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Stat label="Invested" value={fmtRs(plan.invested)} sub={`${plan.tradeCount} trades`} />
              <Stat label="Fees" value={fmtRs2(plan.fees.total)} sub={feeSub(plan.fees)} />
              <Stat label="Grand total" value={fmtRs(plan.grandTotal)} />
              <Stat label="Left over" value={fmtRs2(plan.buffer)} sub="unspent cash" />
            </div>

            {plan.warnings.length > 0 && (
              <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                {plan.warnings.map((w, i) => (
                  <div key={i} className="mb-1 last:mb-0">
                    ⚠ {w}
                  </div>
                ))}
              </div>
            )}

            <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500 dark:bg-neutral-900">
                  <tr>
                    <th className="px-3 py-2">Symbol</th>
                    <th className="px-3 py-2 text-right">Norm. weight</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Shares</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {orderedPlanRows.map((r) => (
                    <tr
                      key={r.symbol}
                      className={r.shares === 0 ? "text-neutral-400 dark:text-neutral-600" : ""}
                    >
                      <td className="px-3 py-2 font-semibold">
                        {r.symbol}
                        {r.stalePrice && <span title="price reused from an earlier quote">*</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtWeight(r.normWeight * 100)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtRs2(r.price)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtQty(r.shares)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtRs(r.cost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-neutral-200 text-sm font-semibold dark:border-neutral-800">
                  <tr>
                    <td className="px-3 py-2" colSpan={4}>
                      Invested
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtRs(plan.invested)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </>
        )}

        <p className="rounded-lg bg-neutral-100 p-3 text-xs leading-relaxed text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
          <b>Allocation math only — not financial or investment advice.</b> This page divides an amount
          you choose across symbols you choose, in proportion to the published index weights. It does
          not suggest whether, when, or what to buy. Fee figures are estimates from the configurable
          schedule above and may differ from your broker&apos;s actual charges and taxes. Prices move —
          re-check quotes before ordering. Your decisions are your own.
        </p>
      </div>
    </div>
  );
}

/** Symbols outside the heaviest `n` — i.e. what Top N should untick. */
function outsideTopN(rows: { symbol: string; weight: number | null }[], n: number): Set<string> {
  if (n >= rows.length) return new Set();
  const keep = new Set(
    [...rows]
      .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
      .slice(0, Math.max(0, n))
      .map((r) => r.symbol),
  );
  return new Set(rows.filter((r) => !keep.has(r.symbol)).map((r) => r.symbol));
}

/** An empty or junk Top N box means "no limit" rather than "select nothing". */
function parseTopN(text: string): number {
  const n = parseInt(text.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER;
}

function sortBasket(rows: BasketRow[], sort: SortKey): BasketRow[] {
  return [...rows].sort((a, b) => {
    if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
    if (sort === "price") return (b.resolvedPrice ?? 0) - (a.resolvedPrice ?? 0);
    return (b.weight ?? 0) - (a.weight ?? 0);
  });
}

function sortPlanRows(rows: PlanRow[], sort: SortKey): PlanRow[] {
  return [...rows].sort((a, b) => {
    if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
    if (sort === "price") return b.price - a.price;
    return b.normWeight - a.normWeight;
  });
}

function feeSub(fees: { commission: number; cdcTxn: number; setup: number }): string {
  const parts = [`${fmtRs2(fees.commission)} commission`, `${fmtRs2(fees.cdcTxn)} CDC`];
  if (fees.setup > 0) parts.push(`${fmtRs2(fees.setup)} setup`);
  return parts.join(" · ");
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
      {children}
    </h2>
  );
}

function Notice({ tone, children }: { tone: "amber" | "neutral"; children: React.ReactNode }) {
  const tones = {
    amber: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
    neutral: "bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400",
  };
  return <div className={`mt-2 rounded-lg p-2.5 text-xs ${tones[tone]}`}>{children}</div>;
}

function QuickButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-neutral-300 px-2.5 py-1 text-xs font-medium hover:bg-neutral-50 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-900"
    >
      {children}
    </button>
  );
}

function FeeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-xs">
      <span className="text-neutral-500">{label}</span>
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-0.5 w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1 tabular-nums focus:border-blue-500 focus:outline-none dark:border-neutral-700"
      />
    </label>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-0.5 text-lg font-bold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-neutral-500">{sub}</div>}
    </div>
  );
}
