/**
 * A bare price line — no axes, no grid, no labels.
 *
 * At this size a chart's only job is shape: is it climbing, falling, or choppy.
 * Anything else is noise at 120×32. Coloured by net direction over the window,
 * matching the P&L colours used everywhere else.
 */
export default function Sparkline({
  points,
  width = 120,
  height = 32,
  className = "",
}: {
  points: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (points.length < 2) {
    return <div style={{ width, height }} className={className} aria-hidden />;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  // A perfectly flat series would divide by zero; draw it down the middle.
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  // 1px inset top and bottom so the stroke isn't clipped at the extremes.
  const y = (v: number) => height - 1 - ((v - min) / span) * (height - 2);

  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(2)},${y(p).toFixed(2)}`).join(" ");
  const rising = points[points.length - 1] >= points[0];
  const stroke = rising ? "var(--gain)" : "var(--loss)";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={`Price trend, ${rising ? "up" : "down"} over the period`}
      preserveAspectRatio="none"
    >
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
