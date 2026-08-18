import { fmtMoney } from "@/lib/format";

/**
 * Allocation by value, as a ring with a legend.
 *
 * **The legend is the text alternative, so the ring is `aria-hidden`.** Every
 * slice already appears below it as a label, a percentage and an amount — a
 * `role="img"` with a summarising `aria-label` would make a screen reader read
 * the same twelve holdings twice, once approximately and once exactly. The
 * `figure`/`figcaption` names the pair so the list is not encountered as a bare
 * run of numbers.
 *
 * Painted from the design tokens; it had kept its own `neutral-*` greys, which
 * left the legend's amounts at a different weight from every other muted number
 * on the page. The slice palette stays literal — an SVG `stroke` cannot take a
 * Tailwind class, and these are categorical colours rather than semantic ones,
 * so they are not the `--gain`/`--loss` pair.
 */
const PALETTE = [
  "#2563eb", "#16a34a", "#db2777", "#f59e0b", "#7c3aed",
  "#0891b2", "#dc2626", "#65a30d", "#c026d3", "#0d9488",
  "#ea580c", "#4f46e5",
];
const OTHERS_COLOR = "#94a3b8";

export default function AllocationDonut({
  data,
  currency = "PKR",
}: {
  data: { label: string; value: number }[];
  /** The currency `value` is stated in. The portfolio page totals in either PKR or USD. */
  currency?: string;
}) {
  const positive = data.filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  if (positive.length === 0) {
    return <p className="text-sm text-muted">No positions to chart yet.</p>;
  }

  // Cap the legend: top 9 + aggregated "Others".
  const MAX = 9;
  let slices = positive;
  if (positive.length > MAX) {
    const head = positive.slice(0, MAX);
    const othersValue = positive.slice(MAX).reduce((s, d) => s + d.value, 0);
    slices = [...head, { label: "Others", value: othersValue }];
  }

  const total = slices.reduce((s, d) => s + d.value, 0);
  const r = 60;
  const C = 2 * Math.PI * r;

  // Cumulative arc offsets are resolved up front so rendering stays a pure map.
  const segments: {
    label: string;
    value: number;
    frac: number;
    start: number;
    color: string;
  }[] = [];
  let start = 0;
  for (const [i, d] of slices.entries()) {
    const frac = d.value / total;
    segments.push({
      label: d.label,
      value: d.value,
      frac,
      start,
      color: d.label === "Others" ? OTHERS_COLOR : PALETTE[i % PALETTE.length],
    });
    start += frac;
  }

  return (
    <figure className="flex flex-col items-center gap-5">
      <figcaption className="sr-only">
        Allocation by market value, {slices.length} slice{slices.length === 1 ? "" : "s"},
        listed below with each share of the total.
      </figcaption>
      <svg viewBox="0 0 160 160" className="h-40 w-40 shrink-0" aria-hidden>
        <g transform="rotate(-90 80 80)">
          {segments.map((d) => {
            const len = d.frac * C;
            return (
              <circle
                key={d.label}
                cx={80}
                cy={80}
                r={r}
                fill="none"
                stroke={d.color}
                strokeWidth={20}
                strokeDasharray={`${len} ${C - len}`}
                strokeDashoffset={-d.start * C}
              />
            );
          })}
        </g>
      </svg>
      <ul className="grid w-full grid-cols-2 gap-x-4 gap-y-3 text-xs">
        {segments.map((d) => {
          const pct = (d.frac * 100).toFixed(1);
          return (
            <li key={d.label} className="flex items-start gap-2">
              <span
                className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: d.color }}
              />
              <div className="min-w-0 leading-tight">
                <div className="flex items-baseline gap-1.5">
                  <span className="truncate font-medium">{d.label}</span>
                  <span className="tabular-nums text-muted">{pct}%</span>
                </div>
                <div className="tabular-nums text-muted">{fmtMoney(d.value, currency)}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
