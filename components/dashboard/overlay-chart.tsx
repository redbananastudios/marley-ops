/**
 * Current-vs-previous overlay chart. Current period renders as bars (brand red),
 * the equivalent previous period as a faint line so the two are directly comparable.
 * Pure SVG — scales to its container, no chart library, no client JS.
 */

import type { Bucket } from "@/lib/dashboard/compute";

const W = 720;
const H = 168;
const PAD_TOP = 10;
const PAD_BOTTOM = 26;
const CHART_H = H - PAD_TOP - PAD_BOTTOM;

export function OverlayChart({
  buckets,
  label,
  current,
  previous,
}: {
  buckets: Bucket[];
  label: string;
  /** totals for the legend */
  current: number;
  previous: number;
}) {
  const n = buckets.length;
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.current, b.previous)));
  const slot = W / n;
  const barW = Math.max(2, Math.min(slot * 0.6, 26));
  const y = (v: number) => PAD_TOP + CHART_H * (1 - v / max);
  const cx = (i: number) => i * slot + slot / 2;

  const prevPts = buckets.map((b, i) => `${cx(i).toFixed(1)},${y(b.previous).toFixed(1)}`).join(" ");
  const hasPrev = buckets.some((b) => b.previous > 0);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="eyebrow">{label}</p>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5 text-foreground">
            <span className="inline-block size-2.5 rounded-[2px] bg-mm-red" /> This period
            <span className="tabular ml-0.5 font-medium">{current}</span>
          </span>
          <span className="flex items-center gap-1.5 text-mist-400">
            <span className="inline-block h-0.5 w-3.5 rounded bg-mist-300" /> Previous
            <span className="tabular ml-0.5">{previous}</span>
          </span>
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" preserveAspectRatio="none" role="img" aria-label={label}>
        {/* baseline */}
        <line x1="0" y1={PAD_TOP + CHART_H} x2={W} y2={PAD_TOP + CHART_H} stroke="#e4e4e7" strokeWidth="1" />

        {/* current bars */}
        {buckets.map((b, i) => {
          const h = b.current === 0 ? 0 : Math.max(2, (b.current / max) * CHART_H);
          return (
            <rect
              key={i}
              x={cx(i) - barW / 2}
              y={PAD_TOP + CHART_H - h}
              width={barW}
              height={h}
              rx="2"
              fill="#c03838"
            >
              <title>{`${b.label || i}: ${b.current}`}</title>
            </rect>
          );
        })}

        {/* previous line + dots */}
        {hasPrev ? (
          <>
            <polyline
              points={prevPts}
              fill="none"
              stroke="#a1a1aa"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            {buckets.map((b, i) =>
              b.previous > 0 ? <circle key={i} cx={cx(i)} cy={y(b.previous)} r="2.5" fill="#a1a1aa" /> : null,
            )}
          </>
        ) : null}
      </svg>

      {/* x ticks */}
      <div className="mt-1 flex text-[10px] text-mist-400">
        {buckets.map((b, i) => (
          <span key={i} className="flex-1 text-center">
            {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}
