/**
 * The market-movement engine: how much did a thing move, and what moved most.
 *
 * Pure arithmetic over daily bars — no Prisma, no fetch, no tickers. Every market
 * goes through the same functions, which is why "top gainers" means the same
 * thing for crypto as it does for PSX, and why adding an asset class needs no
 * change here at all.
 *
 * Two conventions worth knowing:
 *
 *   - A window is anchored to the *latest bar*, not to today. A market closed for
 *     a holiday reports its last real session rather than a fabricated 0%.
 *   - A window needs a bar at or before its start date. Where there is none, the
 *     change is `null` — "insufficient data", never 0 and never an extrapolation.
 */
import type { BarData } from "./types";

/** Windows the UI offers. `day` is the latest bar against the one before it. */
export const PERIODS = ["day", "week", "month", "quarter", "ytd", "year"] as const;
export type Period = (typeof PERIODS)[number];

export const PERIOD_LABEL: Record<Period, string> = {
  day: "1D",
  week: "1W",
  month: "1M",
  quarter: "3M",
  ytd: "YTD",
  year: "1Y",
};

/** Calendar days back from the latest bar. `day` and `ytd` are computed differently. */
const PERIOD_DAYS: Record<Exclude<Period, "day" | "ytd">, number> = {
  week: 7,
  month: 30,
  quarter: 91,
  year: 365,
};

export interface PeriodChange {
  /** Price at the start of the window (the reference close). */
  from: number;
  /** Price at the end of the window (the latest close). */
  to: number;
  change: number;
  changePct: number;
  /** The bar dates actually used — so the UI can say what it measured. */
  fromDate: string;
  toDate: string;
}

export interface AssetPerformance {
  assetId: string;
  latest: number | null;
  latestDate: string | null;
  /** Null for any window the series cannot cover. */
  periods: Partial<Record<Period, PeriodChange>>;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * The last bar at or before `date`.
 *
 * Bars must be sorted oldest-first. Uses the most recent prior session, so a
 * window starting on a weekend or a holiday anchors to the Friday close rather
 * than reporting nothing.
 */
export function barOnOrBefore(bars: readonly BarData[], date: string): BarData | null {
  let lo = 0;
  let hi = bars.length - 1;
  let found: BarData | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= date) {
      found = bars[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The date a window opens on, given the date it closes on.
 *
 * `day` has no calendar start — it is the previous *session*, whenever that was —
 * so it answers null and is handled separately by anything that walks the periods.
 *
 * Exported because a chart needs the same window the numbers were computed over.
 * Two definitions of "one month" would drift, and the drift would show up as a
 * chart that disagreed with the percentage printed above it.
 */
export function windowStart(toDate: string, period: Period): string | null {
  if (period === "day") return null;
  if (period === "ytd") return `${toDate.slice(0, 4)}-01-01`;
  return shiftDate(toDate, PERIOD_DAYS[period]);
}

function pctChange(from: number, to: number, fromDate: string, toDate: string): PeriodChange | null {
  // A zero or negative reference makes a percentage meaningless. Yields can go to
  // zero; saying "insufficient data" beats printing Infinity.
  if (!Number.isFinite(from) || from === 0) return null;
  const change = to - from;
  return { from, to, change, changePct: (change / from) * 100, fromDate, toDate };
}

/**
 * Compute every window for one asset's series.
 *
 * `bars` must be sorted oldest-first and hold one entry per session.
 */
export function computePerformance(assetId: string, bars: BarData[]): AssetPerformance {
  const latestBar = bars.at(-1) ?? null;
  const result: AssetPerformance = {
    assetId,
    latest: latestBar?.close ?? null,
    latestDate: latestBar?.date ?? null,
    periods: {},
  };
  if (!latestBar) return result;

  const to = latestBar.close;
  const toDate = latestBar.date;

  const prev = bars.at(-2);
  if (prev) {
    const day = pctChange(prev.close, to, prev.date, toDate);
    if (day) result.periods.day = day;
  }

  for (const period of PERIODS) {
    const from = windowStart(toDate, period);
    // `day` is the previous session, already handled above.
    if (!from) continue;
    const start = barOnOrBefore(bars, from);
    // Anchoring to the latest bar would report a 0% move rather than admitting
    // the series is too short to answer.
    if (!start || start.date === toDate) continue;
    const change = pctChange(start.close, to, start.date, toDate);
    if (change) result.periods[period] = change;
  }

  return result;
}

/** Convenience: the percentage move over one window, or null. */
export function changePct(perf: AssetPerformance, period: Period): number | null {
  return perf.periods[period]?.changePct ?? null;
}

/* ------------------------------------------------------------------ movers */

export interface Mover<T> {
  item: T;
  changePct: number;
  change: number;
  from: number;
  to: number;
}

/**
 * Rank items by their move over `period`, biggest gain first.
 *
 * Anything without a computable change for that window is dropped, not sorted to
 * the bottom — an asset with no data is not "flat".
 */
export function rankByChange<T>(
  items: T[],
  perfOf: (item: T) => AssetPerformance | undefined,
  period: Period,
): Mover<T>[] {
  const ranked: Mover<T>[] = [];
  for (const item of items) {
    const p = perfOf(item)?.periods[period];
    if (!p) continue;
    ranked.push({ item, changePct: p.changePct, change: p.change, from: p.from, to: p.to });
  }
  return ranked.sort((a, b) => b.changePct - a.changePct);
}

export interface MoversResult<T> {
  gainers: Mover<T>[];
  losers: Mover<T>[];
  /** Ranked by |change| in the asset's own currency — a different question to %. */
  biggestAbsolute: Mover<T>[];
}

/** Top gainers, top losers, and biggest absolute moves over one window. */
export function topMovers<T>(
  items: T[],
  perfOf: (item: T) => AssetPerformance | undefined,
  period: Period,
  limit = 5,
): MoversResult<T> {
  const ranked = rankByChange(items, perfOf, period);
  return {
    gainers: ranked.filter((m) => m.changePct > 0).slice(0, limit),
    losers: ranked
      .filter((m) => m.changePct < 0)
      .slice(-limit)
      .reverse(),
    biggestAbsolute: [...ranked]
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, limit),
  };
}

/**
 * Moves far enough from an asset's own recent behaviour to be worth explaining.
 *
 * Scores each daily move in standard deviations of that asset's daily returns
 * over `lookback` sessions, so a 3% day flags for a utility and not for a
 * small-cap. This is what decides which assets are worth spending a news lookup
 * and an LLM call on — not a fixed percentage threshold.
 *
 * Returns null when the series is too short to have a meaningful deviation.
 */
export function unusualMove(
  bars: BarData[],
  lookback = 60,
  minSessions = 20,
): { changePct: number; sigma: number; zScore: number } | null {
  if (bars.length < minSessions + 1) return null;
  const window = bars.slice(-(lookback + 1));

  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1].close;
    if (prev === 0) continue;
    returns.push(((window[i].close - prev) / prev) * 100);
  }
  if (returns.length < minSessions) return null;

  const latest = returns.at(-1)!;
  // Exclude the day being judged, so a huge move doesn't inflate the very
  // deviation it is being measured against.
  const history = returns.slice(0, -1);
  const mean = history.reduce((s, r) => s + r, 0) / history.length;
  const variance = history.reduce((s, r) => s + (r - mean) ** 2, 0) / history.length;
  const sigma = Math.sqrt(variance);
  if (sigma === 0) return null;

  return { changePct: latest, sigma, zScore: (latest - mean) / sigma };
}
