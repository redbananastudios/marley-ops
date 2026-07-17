import { useCurrentFrame, interpolate, Easing } from "remotion";
import { COLORS } from "../brand";

/** A simplified, drawn phone with UI rows that stagger in and a pulsing red
 *  ring on a tap target — the manual's phone-frame illustration language,
 *  animated. Used on each section's slide beat. `accent` tints the target. */
export const PhoneGlyph: React.FC<{ rows?: number; targetRow?: number; accent?: string }> = ({
  rows = 4,
  targetRow = 1,
  accent = COLORS.red,
}) => {
  const frame = useCurrentFrame();
  const W = 300;
  const H = 600;
  const rowH = 66;
  const top = 120;

  // Device draw-in.
  const dev = interpolate(frame, [0, 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  // Pulsing ring on the tap target.
  const pulse = interpolate(frame % 45, [0, 22, 44], [0.9, 1.18, 0.9], {
    easing: Easing.inOut(Easing.ease),
  });
  const ringOpacity = interpolate(frame % 45, [0, 22, 44], [0.9, 0.35, 0.9]);
  const targetY = top + targetRow * rowH + rowH / 2;

  return (
    <svg
      viewBox={`0 0 ${W + 40} ${H + 40}`}
      width={430}
      height={620}
      style={{ opacity: dev, translate: interpolate(dev, [0, 1], ["0px 30px", "0px 0px"]) }}
    >
      {/* bezel */}
      <rect x={20} y={20} width={W} height={H} rx={44} fill="#0C0C0D" stroke="rgba(255,255,255,0.10)" strokeWidth={2} />
      {/* screen */}
      <rect x={34} y={34} width={W - 28} height={H - 28} rx={32} fill={COLORS.cream} />
      {/* notch */}
      <rect x={W / 2 - 30} y={44} width={90} height={16} rx={8} fill="#0C0C0D" />
      {/* header wordmark bar */}
      <rect x={54} y={78} width={140} height={16} rx={8} fill={COLORS.charcoal} />
      <rect x={200} y={78} width={40} height={16} rx={8} fill={accent} />

      {/* content rows, staggered in */}
      {Array.from({ length: rows }).map((_, i) => {
        const appear = interpolate(frame, [10 + i * 6, 22 + i * 6], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.16, 1, 0.3, 1),
        });
        const y = top + i * rowH;
        const isTarget = i === targetRow;
        return (
          <g key={i} style={{ opacity: appear, translate: interpolate(appear, [0, 1], ["18px 0px", "0px 0px"]) }}>
            <rect
              x={54}
              y={y}
              width={W - 48}
              height={rowH - 14}
              rx={14}
              fill={COLORS.white}
              stroke={isTarget ? accent : "rgba(0,0,0,0.06)"}
              strokeWidth={isTarget ? 3 : 1.5}
            />
            <rect x={70} y={y + 14} width={isTarget ? 150 : 120 - i * 8} height={12} rx={6} fill={COLORS.charcoal} opacity={0.82} />
            <rect x={70} y={y + 32} width={80} height={9} rx={5} fill={COLORS.mist400} />
            {isTarget ? <circle cx={W - 6} cy={y + (rowH - 14) / 2} r={7} fill={accent} /> : null}
          </g>
        );
      })}

      {/* pulsing tap ring on the target row */}
      <circle
        cx={W / 2 + 4}
        cy={targetY}
        r={40}
        fill="none"
        stroke={accent}
        strokeWidth={4}
        opacity={ringOpacity * dev}
        style={{ scale: String(pulse), transformOrigin: `${W / 2 + 4}px ${targetY}px` }}
      />
    </svg>
  );
};
