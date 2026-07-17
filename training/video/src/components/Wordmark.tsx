import { Img, staticFile } from "remotion";
import { brand, COLORS } from "../brand";

/** "MARLEY OPS" lockup — house-tile logo + Cormorant wordmark, matching the
 *  app's <BrandMark>. */
export const Wordmark: React.FC<{ scale?: number; showTile?: boolean }> = ({ scale = 1, showTile = true }) => {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18 * scale }}>
      {showTile ? (
        <div
          style={{
            width: 72 * scale,
            height: 72 * scale,
            borderRadius: 16 * scale,
            background: COLORS.white,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
          }}
        >
          <Img src={staticFile("brand/logo.png")} style={{ width: 58 * scale, height: "auto" }} />
        </div>
      ) : null}
      <div
        style={{
          fontFamily: brand,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: `${0.03 * scale}em`,
          fontSize: 46 * scale,
          lineHeight: 1,
          color: COLORS.white,
        }}
      >
        Marley <span style={{ color: COLORS.redBright }}>Ops</span>
      </div>
    </div>
  );
};
