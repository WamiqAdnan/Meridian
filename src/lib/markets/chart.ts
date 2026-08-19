/**
 * The arithmetic a price chart needs, kept out of the component that draws it.
 *
 * Pure — no Prisma, no fetch, no SVG. Which axis labels to print and which bars to
 * draw are decisions with real edge cases in them (a flat series, a yield quoted in
 * fractions of a percent, an index in five figures, a window shorter than the
 * sessions in it), and none of those are visible by looking at a rendered chart.
 *
 * The window comes from `windowStart` in `performance.ts` rather than its own
 * calendar maths, so the line a chart draws covers exactly the period the
 * percentage above it was computed over.
 */
import { barOnOrBefore, windowStart, type Period } from "./performance";
import type { BarData } from "./types";

/**
 * Fewest sessions to fall back on when a window cannot be drawn.
 *
 * Only two cases reach it: `day`, which is a single session rather than a calendar
 * window, and a series too short to give the window two points. Everything else
 * draws its own window even when that is only a handful of sessions — a five-point
 * week is a thin chart, but it is the chart the label promises.
 */
export const MIN_CHART_POINTS = 10;

export interface ChartWindow {
  /** The bars to draw, oldest-first. */
  bars: BarData[];
  /**
   * True when these bars are the period's own window. False when the window could
   * not be drawn and recent sessions were substituted — which the caption has to
   * say, because the line then spans something other than its label.
   */
  exact: boolean;
}

/**
 * The bars a chart should draw for one window.
 *
 * Anchored on the *reference* session — the last bar at or before the window start,
 * exactly the bar `computePerformance` measures from. Drawing from the first bar
 * *inside* the window instead spans a slightly different move, and on a market that
 * does not trade every day the two can disagree about its direction: FFC's 1M read
 * "+0.18%" beside a line that fell, because the line began after the reference
 * close it was measured against.
 */
export function chartWindow(
  bars: readonly BarData[],
  period: Period,
  minPoints = MIN_CHART_POINTS,
): ChartWindow {
  if (bars.length === 0) return { bars: [], exact: false };

  const from = windowStart(bars[bars.length - 1].date, period);
  if (from) {
    const reference = barOnOrBefore(bars, from);
    const windowed = bars.slice(reference ? bars.indexOf(reference) : 0);
    // One point is not a line. Two is.
    if (windowed.length >= 2) return { bars: windowed, exact: true };
  }
  return { bars: bars.slice(-minPoints), exact: false };
}

/* ------------------------------------------------------------------- axis */

/**
 * A date label for the x-axis: "12 Aug", or "12 Aug 25" when the drawn window
 * spans more than one year.
 *
 * Formatted in UTC, because a bar's `date` *is* a UTC calendar day — the whole
 * market layer stores yyyy-mm-dd and compares it as text. Formatting in the
 * server's own zone instead labels a midnight-UTC instant as the previous day
 * anywhere west of UTC, so the axis would name days the series does not contain.
 */
export function axisDateLabel(date: string, withYear: boolean): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-PK", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    ...(withYear ? { year: "2-digit" } : {}),
  });
}

/* ------------------------------------------------------------------- scale */

export interface PriceScale {
  /** The bottom of the axis — at or below the lowest value. */
  min: number;
  /** The top of the axis — at or above the highest value. */
  max: number;
  /** Gridline values, ascending, `min` and `max` included. */
  ticks: number[];
}

/** Kill the float noise that `min + i * step` accumulates. */
function clean(n: number): number {
  return Number(n.toFixed(10));
}

/**
 * Round a rough interval up to one a human would label an axis with.
 *
 * 1, 2, 2.5, 5 or 10 times a power of ten — so an axis reads 7,700 / 7,750 / 7,800
 * rather than 7,713.6 / 7,761.2 / 7,808.8.
 */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const multiplier =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return clean(multiplier * magnitude);
}

/**
 * Round `value` down (or up) to a multiple of `step`, tolerantly.
 *
 * The tolerance is load-bearing, not defensive padding. `4.6 / 0.05` is
 * 91.99999999999999 in binary floating point, so a plain `Math.floor` drops a
 * whole step and puts an empty gridline below a yield chart — which is exactly
 * what the first version of this did, and what `check:market` caught.
 */
function floorTo(value: number, step: number): number {
  const quotient = value / step;
  const rounded = Math.round(quotient);
  return clean((Math.abs(quotient - rounded) < 1e-9 ? rounded : Math.floor(quotient)) * step);
}

function ceilTo(value: number, step: number): number {
  const quotient = value / step;
  const rounded = Math.round(quotient);
  return clean((Math.abs(quotient - rounded) < 1e-9 ? rounded : Math.ceil(quotient)) * step);
}

/**
 * An axis that covers every value, on round numbers.
 *
 * Deliberately *not* zero-based. A price chart zeroed at the origin turns every
 * equity into a flat line near the top of the frame; what a reader wants from this
 * chart is the shape of the move, and the labels say what the range is.
 *
 * Returns null when there is nothing to scale.
 */
export function priceScale(values: readonly number[], targetTicks = 4): PriceScale | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;

  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (hi === lo) {
    // A flat series still deserves an axis. Open it around the value rather than
    // dividing by a zero span.
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.01;
    lo -= pad;
    hi += pad;
  }

  const step = niceStep((hi - lo) / Math.max(1, targetTicks));
  const min = floorTo(lo, step);
  const max = clean(Math.max(ceilTo(hi, step), min + step));
  const count = Math.max(1, Math.round((max - min) / step));

  return {
    min,
    max,
    ticks: Array.from({ length: count + 1 }, (_, i) => clean(min + i * step)),
  };
}

/* ------------------------------------------------------------------ extent */

/** What a drawn series adds up to — the caption and the high/low read-out. */
export interface SeriesExtent {
  first: number;
  last: number;
  high: number;
  low: number;
  /** yyyy-mm-dd of the first and last bar drawn. */
  from: string;
  to: string;
  sessions: number;
  /** The move across exactly what was drawn. Null when the open was zero. */
  changePct: number | null;
}

export function seriesExtent(bars: readonly BarData[]): SeriesExtent | null {
  if (bars.length === 0) return null;
  const closes = bars.map((b) => b.close);
  const first = closes[0];
  const last = closes[closes.length - 1];
  return {
    first,
    last,
    high: Math.max(...closes),
    low: Math.min(...closes),
    from: bars[0].date,
    to: bars[bars.length - 1].date,
    sessions: bars.length,
    // Same rule as `pctChange`: a zero reference makes a percentage meaningless,
    // and saying so beats printing Infinity.
    changePct: first === 0 ? null : ((last - first) / first) * 100,
  };
}
