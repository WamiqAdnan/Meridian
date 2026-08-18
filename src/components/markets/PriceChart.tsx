import { priceScale, seriesExtent } from "@/lib/markets/chart";
import { fmtPrice } from "@/lib/format";
import type { BarData } from "@/lib/markets/types";

/**
 * Daily closes over one window, with an axis.
 *
 * The grown-up counterpart to `Sparkline`, which deliberately has no axes because
 * at 120×32 they would be noise. Here the question is not just "which way" but
 * "from what to what", so the chart is labelled: round gridlines from
 * `priceScale`, the window's first and last dates, and a dashed line at the
 * opening close so flat is visible as flat.
 *
 * Three deliberate choices:
 *
 *   - **Not zero-based.** A price axis anchored at the origin turns every equity
 *     into a flat line near the top of the frame. The labels say what the range is.
 *   - **The axis carries no currency symbol.** `$104,235.00` at a five-figure BTC
 *     price needs more gutter than the chart can spare, and the currency is stated
 *     once beneath it instead of eight times down the side.
 *   - **No tooltips, so no client component.** Reading one exact day off a
 *     two-year line is not what this chart is for; the high, low and last are
 *     given as text next to it, which works without JavaScript and reads aloud.
 *
 * Coloured by net direction over the drawn window, from the same `--gain`/`--loss`
 * pair as every other price move in the app.
 */

const VIEW = { width: 720, height: 240 };
const PAD = { top: 10, right: 12, bottom: 22, left: 54 };
const PLOT = {
  width: VIEW.width - PAD.left - PAD.right,
  height: VIEW.height - PAD.top - PAD.bottom,
};

/** "12 Aug", or "12 Aug 25" when the window spans more than one year. */
function dateLabel(date: string, withYear: boolean): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-PK", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "2-digit" } : {}),
  });
}

export default function PriceChart({
  bars,
  currency,
  label,
  className = "",
}: {
  bars: BarData[];
  currency: string;
  /** The asset's name, for the accessible description. */
  label: string;
  className?: string;
}) {
  const scale = priceScale(bars.map((b) => b.close));
  const extent = seriesExtent(bars);

  if (!scale || !extent || bars.length < 2) {
    return (
      <div className="rounded-xl border border-dashed border-line p-10 text-center text-sm text-muted">
        Not enough daily history to draw a chart. Run{" "}
        <code className="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs">
          npm run market:backfill
        </code>
        .
      </div>
    );
  }

  const span = scale.max - scale.min;
  const x = (i: number) => PAD.left + (i / (bars.length - 1)) * PLOT.width;
  const y = (value: number) => PAD.top + ((scale.max - value) / span) * PLOT.height;

  const line = bars.map((b, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(b.close).toFixed(1)}`).join(" ");
  const area = `${line} L${x(bars.length - 1).toFixed(1)},${(PAD.top + PLOT.height).toFixed(1)} L${PAD.left},${(PAD.top + PLOT.height).toFixed(1)} Z`;

  const rising = extent.last >= extent.first;
  const stroke = rising ? "var(--gain)" : "var(--loss)";

  const step = scale.ticks.length > 1 ? scale.ticks[1] - scale.ticks[0] : 1;
  const digits = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
  const axisFormat = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

  const multiYear = extent.from.slice(0, 4) !== extent.to.slice(0, 4);
  const midpoint = Math.floor((bars.length - 1) / 2);
  const xLabels = [
    { i: 0, anchor: "start" as const },
    { i: midpoint, anchor: "middle" as const },
    { i: bars.length - 1, anchor: "end" as const },
  ];

  const direction = extent.changePct == null ? "unchanged" : rising ? "up" : "down";
  const move = extent.changePct == null ? "" : ` ${direction} ${Math.abs(extent.changePct).toFixed(2)}%`;

  return (
    <svg
      viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
      className={`h-auto w-full ${className}`}
      role="img"
      aria-label={`${label}: ${extent.sessions} daily closes from ${extent.from} to ${extent.to}, ranging ${fmtPrice(extent.low, currency)} to ${fmtPrice(extent.high, currency)}, ending at ${fmtPrice(extent.last, currency)}${move} over the window.`}
    >
      {/* Gridlines and their labels. */}
      {scale.ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={PAD.left}
            x2={VIEW.width - PAD.right}
            y1={y(tick)}
            y2={y(tick)}
            stroke="var(--border)"
            strokeWidth="1"
          />
          <text
            x={PAD.left - 8}
            y={y(tick)}
            textAnchor="end"
            dominantBaseline="middle"
            fontSize="10"
            fill="var(--muted)"
            className="tabular-nums"
          >
            {axisFormat.format(tick)}
          </text>
        </g>
      ))}

      {/* Where the window opened — so a line that ends where it began looks it. */}
      <line
        x1={PAD.left}
        x2={VIEW.width - PAD.right}
        y1={y(extent.first)}
        y2={y(extent.first)}
        stroke="var(--muted)"
        strokeWidth="1"
        strokeDasharray="3 3"
        opacity="0.5"
      />

      <path d={area} fill={stroke} opacity="0.1" />
      <path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(bars.length - 1)} cy={y(extent.last)} r="3" fill={stroke} />

      {xLabels.map(({ i, anchor }) => (
        <text
          key={i}
          x={x(i)}
          y={VIEW.height - 6}
          textAnchor={anchor}
          fontSize="10"
          fill="var(--muted)"
        >
          {dateLabel(bars[i].date, multiYear)}
        </text>
      ))}
    </svg>
  );
}
