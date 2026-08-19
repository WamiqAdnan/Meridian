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

export function fmtQty(n: number): string {
  return pkr0.format(n);
}

/**
 * A holding size.
 *
 * Whole shares print whole; a fractional crypto position keeps its digits. Using
 * `fmtQty` here would render 0.05 BTC as "0", which is a holding the app claims
 * you do not have.
 */
export function fmtUnits(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return pkr0.format(n);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }).format(n);
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

/* --------------------------------------------------------- multi-currency */
/*
 * The formatters above are PKR-only and predate markets; they are still used by
 * the PSX pages and are deliberately unchanged. Everything below handles an
 * arbitrary quote currency, plus the two pseudo-currencies the market layer uses
 * for values that are not money:
 *
 *   PTS  an index level  — 7,745.06, no symbol
 *   PCT  a bond yield    — 4.724%
 */

const SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
  PKR: "Rs ",
  AED: "AED ",
  CHF: "CHF ",
  CAD: "C$",
  AUD: "A$",
};

/** Currencies conventionally written without decimal places. */
const ZERO_DECIMAL = new Set(["JPY", "PKR"]);

function decimalsFor(currency: string, value: number): number {
  if (currency === "PCT") return 3;
  if (currency === "PTS") return 2;
  if (ZERO_DECIMAL.has(currency)) return 0;
  // Sub-dollar assets (a penny crypto, natural gas) need the extra digits or
  // every one of them renders as the same number.
  return Math.abs(value) < 1 ? 4 : 2;
}

/**
 * A price in its own quote currency.
 *
 * `Rs 443`, `$4,447.20`, `7,745.06`, `4.724%` — the shape follows the currency,
 * so an index level never grows a dollar sign and a yield always keeps its
 * percent.
 */
export function fmtPrice(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const ccy = currency.toUpperCase();
  const digits = decimalsFor(ccy, value);
  const body = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

  if (ccy === "PCT") return `${body}%`;
  if (ccy === "PTS") return body;
  const symbol = SYMBOLS[ccy];
  return symbol ? `${symbol}${body}` : `${body} ${ccy}`;
}

/** A money amount, always with a currency marker and no more than 2 decimals. */
export function fmtMoney(value: number | null | undefined, currency: string): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const ccy = currency.toUpperCase();
  const digits = ZERO_DECIMAL.has(ccy) ? 0 : 2;
  const body = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  const symbol = SYMBOLS[ccy];
  return symbol ? `${symbol}${body}` : `${body} ${ccy}`;
}

/**
 * A move, expressed the way that market expresses it.
 *
 * A yield moving 4.60 → 4.72 is "+12 bps", not "+2.61%" — quoting a percentage
 * change of a percentage is how rate moves get misread.
 */
export function fmtMove(
  changePct: number | null | undefined,
  change: number | null | undefined,
  currency: string,
): string {
  if (currency.toUpperCase() === "PCT") {
    if (change == null || !Number.isFinite(change)) return "—";
    const bps = Math.round(change * 100);
    return `${bps >= 0 ? "+" : ""}${bps} bps`;
  }
  return fmtPct(changePct);
}

/** "1.2M", "847.3K" — for volumes and market caps, where full digits are noise. */
export function fmtCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

/** "3 min ago", "2 hours ago" — freshness, which matters more than the clock time. */
export function fmtAgo(d: Date | string | null | undefined): string {
  if (!d) return "never";
  const date = typeof d === "string" ? new Date(d) : d;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "never";
  if (seconds < 60) return "just now";
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (let i = units.length - 1; i >= 0; i--) {
    const [size, unit] = units[i];
    if (seconds >= size) return rtf.format(-Math.round(seconds / size), unit);
  }
  return rtf.format(-Math.round(seconds / 60), "minute");
}
