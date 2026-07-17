import { AbsoluteFill, Sequence, useCurrentFrame, interpolate, Easing } from "remotion";
import { COLORS, sans } from "../brand";
import type { Beat } from "../timeline";
import { PhoneFrame } from "./PhoneFrame";
import { SectionSlideBeat } from "./Slides";
import { Captions, toCaptions } from "./Captions";

/** One body part: a slide beat, then the screen recording in a phone frame
 *  with the section title beside it. Captions run the whole section. */
export const Section: React.FC<{ beat: Extract<Beat, { kind: "section" }> }> = ({ beat }) => {
  const { part, slideF, durF } = beat;
  const frame = useCurrentFrame();
  const captions = toCaptions(beat.audio.words);

  // Side panel eases in as the footage takes over.
  const panel = interpolate(frame, [slideF, slideF + 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });

  return (
    <AbsoluteFill style={{ background: COLORS.charcoal }}>
      {/* Slide beat first. */}
      <Sequence durationInFrames={slideF} name={`${part.id}-slide`}>
        <SectionSlideBeat part={part} />
      </Sequence>

      {/* Then the footage-in-phone layout. */}
      <Sequence from={slideF} durationInFrames={durF - slideF} name={`${part.id}-footage`}>
        <AbsoluteFill style={{ background: COLORS.charcoal }}>
          <div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", padding: "40px 140px", gap: 110 }}>
            <div style={{ flexShrink: 0 }}>
              <PhoneFrame src={part.footage} height={900} trimBefore={0} />
            </div>
            <div style={{ flex: 1, opacity: panel, translate: interpolate(panel, [0, 1], ["30px 0px", "0px 0px"]) }}>
              <div
                style={{
                  fontFamily: sans,
                  fontSize: 26,
                  fontWeight: 700,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: COLORS.redBright,
                }}
              >
                Part {part.n} of 8
              </div>
              <div
                style={{
                  fontFamily: sans,
                  fontSize: 76,
                  fontWeight: 800,
                  color: COLORS.white,
                  letterSpacing: "-0.03em",
                  lineHeight: 1.05,
                  marginTop: 12,
                }}
              >
                {part.title}
              </div>
              <div style={{ fontFamily: sans, fontSize: 36, fontWeight: 500, color: COLORS.mist300, marginTop: 20, maxWidth: 640 }}>
                {part.hint}
              </div>
            </div>
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Captions across the whole section (timing relative to audio start). */}
      <Captions captions={captions} />
    </AbsoluteFill>
  );
};
