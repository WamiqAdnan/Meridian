const pkr0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const pkr2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "Rs 299,864" — whole rupees. */
export function fmtRs(n: number | null | undefined): string {
  if (n == null) return "—";
  return `Rs ${pkr0.format(n)}`;
}

/** "Rs 876.07" — rupees with paisa (for prices). */
export function fmtRs2(n: number | null | undefined): string {
  if (n == null) return "—";
  return `Rs ${pkr2.format(n)}`;
}

/** "+1.87%" / "-0.41%" with sign. */
export function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—";
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}%`;
}

/** "11.89%" — an index weight, which is never signed (unlike fmtPct). */
export function fmtWeight(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toFixed(2)}%`;
}

/** "+Rs 1,234" / "-Rs 1,234" with sign, whole rupees. */
export function fmtSignedRs(n: number | null | undefined): string {
  if (n == null) return "—";
  const s = n >= 0 ? "+" : "-";
  return `${s}Rs ${pkr0.format(Math.abs(n))}`;
}

export function fmtQty(n: number): string {
  return pkr0.format(n);
}

/** Tailwind text-colour class for a P&L value. */
export function pnlColor(n: number | null | undefined): string {
  if (n == null) return "text-neutral-400";
  if (n > 0) return "text-emerald-600 dark:text-emerald-400";
  if (n < 0) return "text-rose-600 dark:text-rose-400";
  return "text-neutral-500";
}

export function fmtTime(d: Date | string | null | undefined): string {
  if (!d) return "never";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" });
}
