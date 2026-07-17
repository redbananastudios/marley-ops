import { AbsoluteFill, useCurrentFrame, interpolate, Easing } from "remotion";
import { COLORS, sans } from "../brand";
import { PROCESS_STEPS, type PARTS } from "../timeline";
import { PhoneGlyph } from "./PhoneGlyph";
import { Wordmark } from "./Wordmark";

const eyebrow: React.CSSProperties = {
  fontFamily: sans,
  fontSize: 26,
  fontWeight: 700,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: COLORS.redBright,
};

const fadeUp = (frame: number, start: number, dist = 26) => ({
  opacity: interpolate(frame, [start, start + 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
  translate: interpolate(frame, [start, start + 16], [`0px ${dist}px`, "0px 0px"], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  }),
});

/** Opening title card. */
export const TitleCard: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: COLORS.charcoal, alignItems: "center", justifyContent: "center", gap: 40 }}>
      <div style={fadeUp(frame, 4)}>
        <Wordmark scale={1.7} />
      </div>
      <div style={{ ...fadeUp(frame, 18), textAlign: "center" }}>
        <div style={{ fontFamily: sans, fontSize: 58, fontWeight: 800, color: COLORS.white, letterSpacing: "-0.02em" }}>
          Crew training
        </div>
        <div style={{ fontFamily: sans, fontSize: 34, fontWeight: 500, color: COLORS.mist400, marginTop: 10 }}>
          Your day, step by step
        </div>
      </div>
      <div style={{ ...fadeUp(frame, 30), width: 120, height: 5, borderRadius: 3, background: COLORS.red }} />
    </AbsoluteFill>
  );
};

/** The "how we work" loop — five chips lighting up in narration order. */
export const ProcessSlide: React.FC = () => {
  const frame = useCurrentFrame();
  // Spread the five highlights across ~the intro's 22s (660f), after a lead-in.
  const per = 118;
  const lead = 60;
  return (
    <AbsoluteFill style={{ background: COLORS.charcoal, alignItems: "center", justifyContent: "center", gap: 56 }}>
      <div style={{ ...fadeUp(frame, 4), textAlign: "center" }}>
        <div style={eyebrow}>The way we work</div>
        <div
          style={{
            fontFamily: sans,
            fontSize: 62,
            fontWeight: 800,
            color: COLORS.white,
            letterSpacing: "-0.02em",
            marginTop: 12,
          }}
        >
          Every day runs the same way
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 20, maxWidth: 1680, flexWrap: "nowrap" }}>
        {PROCESS_STEPS.map((step, i) => {
          const on = frame >= lead + i * per;
          const glow = interpolate(frame, [lead + i * per, lead + i * per + 14], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <div
                style={{
                  width: 250,
                  minHeight: 150,
                  borderRadius: 22,
                  padding: "22px 20px",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                  textAlign: "center",
                  background: on ? COLORS.red : COLORS.charcoalCard,
                  border: `2px solid ${on ? COLORS.redBright : COLORS.cardBorder}`,
                  scale: String(interpolate(glow, [0, 1], [0.96, 1])),
                }}
              >
                <div
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: 999,
                    background: on ? COLORS.white : "rgba(255,255,255,0.08)",
                    color: on ? COLORS.redDeep : COLORS.mist400,
                    fontFamily: sans,
                    fontWeight: 800,
                    fontSize: 24,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {i + 1}
                </div>
                <div style={{ fontFamily: sans, fontSize: 27, fontWeight: 700, color: on ? COLORS.white : COLORS.mist300, lineHeight: 1.2 }}>
                  {step}
                </div>
              </div>
              {i < PROCESS_STEPS.length - 1 ? (
                <div style={{ fontSize: 40, color: on ? COLORS.redBright : COLORS.mist400 }}>→</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** Per-section slide beat: big number + title + phone glyph. */
export const SectionSlideBeat: React.FC<{ part: (typeof PARTS)[number] }> = ({ part }) => {
  const frame = useCurrentFrame();
  const targetRow = Math.min(3, (part.n - 1) % 4);
  return (
    <AbsoluteFill style={{ background: COLORS.charcoal }}>
      <div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", padding: "0 150px", gap: 90 }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...fadeUp(frame, 2), ...eyebrow }}>Part {part.n} of 9</div>
          <div
            style={{
              ...fadeUp(frame, 8),
              fontFamily: sans,
              fontSize: 92,
              fontWeight: 800,
              color: COLORS.white,
              letterSpacing: "-0.03em",
              lineHeight: 1.02,
              marginTop: 14,
            }}
          >
            {part.title}
          </div>
          <div
            style={{
              ...fadeUp(frame, 16),
              fontFamily: sans,
              fontSize: 40,
              fontWeight: 500,
              color: COLORS.mist300,
              marginTop: 22,
              maxWidth: 720,
            }}
          >
            {part.hint}
          </div>
        </div>
        <div style={{ flexShrink: 0 }}>
          <PhoneGlyph targetRow={targetRow} rows={4} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Recap loop — same five steps, all lit. */
export const RecapSlide: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: COLORS.charcoal, alignItems: "center", justifyContent: "center", gap: 50 }}>
      <div style={{ ...fadeUp(frame, 2), ...eyebrow }}>That is your day</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18, width: 900 }}>
        {PROCESS_STEPS.map((step, i) => {
          const s = fadeUp(frame, 8 + i * 8);
          return (
            <div
              key={i}
              style={{
                ...s,
                display: "flex",
                alignItems: "center",
                gap: 22,
                background: COLORS.charcoalCard,
                border: `2px solid ${COLORS.cardBorder}`,
                borderRadius: 18,
                padding: "20px 28px",
              }}
            >
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 999,
                  background: COLORS.red,
                  color: COLORS.white,
                  fontFamily: sans,
                  fontWeight: 800,
                  fontSize: 24,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </div>
              <div style={{ fontFamily: sans, fontSize: 36, fontWeight: 700, color: COLORS.white }}>{step}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** Closing card, stamped with the build sha. */
export const OutroCard: React.FC<{ sha: string }> = ({ sha }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: COLORS.charcoal, alignItems: "center", justifyContent: "center", gap: 34 }}>
      <div style={fadeUp(frame, 2)}>
        <Wordmark scale={1.5} />
      </div>
      <div
        style={{
          ...fadeUp(frame, 14),
          fontFamily: sans,
          fontSize: 40,
          fontWeight: 600,
          color: COLORS.mist300,
          textAlign: "center",
        }}
      >
        Anything looks wrong on a job? Call the office before you set off.
      </div>
      <div
        style={{
          ...fadeUp(frame, 24),
          fontFamily: sans,
          fontSize: 24,
          fontWeight: 600,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: COLORS.mist400,
        }}
      >
        Marley Ops · v {sha}
      </div>
    </AbsoluteFill>
  );
};
