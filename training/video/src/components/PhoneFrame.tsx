import { Video } from "@remotion/media";
import { staticFile, useCurrentFrame, interpolate, Easing } from "remotion";
import { COLORS } from "../brand";

/** A drawn phone frame (charcoal bezel + notch) with the portrait screen
 *  recording composited inside. The whole device eases up + in on mount. */
export const PhoneFrame: React.FC<{
  src: string;
  height?: number;
  enterFrom?: number;
  trimBefore?: number;
}> = ({ src, height = 940, enterFrom = 0, trimBefore = 0 }) => {
  const frame = useCurrentFrame();
  const aspect = 390 / 844;
  const screenH = height;
  const screenW = Math.round(screenH * aspect);
  const bezel = 16;
  const frameW = screenW + bezel * 2;
  const frameH = screenH + bezel * 2;

  const t = interpolate(frame, [enterFrom, enterFrom + 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  return (
    <div
      style={{
        width: frameW,
        height: frameH,
        borderRadius: 52,
        background: "#0C0C0D",
        border: `2px solid rgba(255,255,255,0.09)`,
        padding: bezel,
        boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
        translate: interpolate(t, [0, 1], ["0px 46px", "0px 0px"]),
        opacity: t,
        scale: interpolate(t, [0, 1], [0.94, 1]),
      }}
    >
      <div
        style={{
          width: screenW,
          height: screenH,
          borderRadius: 38,
          overflow: "hidden",
          background: COLORS.cream,
          position: "relative",
        }}
      >
        <Video
          src={staticFile(src)}
          trimBefore={trimBefore}
          style={{ width: screenW, height: screenH, objectFit: "cover" }}
        />
        {/* notch */}
        <div
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            translate: "-50% 0",
            width: 118,
            height: 26,
            borderRadius: 16,
            background: "#0C0C0D",
          }}
        />
      </div>
    </div>
  );
};
