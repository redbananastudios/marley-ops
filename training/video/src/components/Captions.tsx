import { useCurrentFrame } from "remotion";
import type { Caption } from "@remotion/captions";
import { COLORS, FPS, sans } from "../brand";
import type { TtsWord } from "../timeline";

/** ElevenLabs word timings -> @remotion/captions Caption[]. */
export function toCaptions(words: TtsWord[]): Caption[] {
  return words.map((w) => ({
    text: w.text,
    startMs: Math.round(w.startSec * 1000),
    endMs: Math.round(w.endSec * 1000),
    timestampMs: Math.round(((w.startSec + w.endSec) / 2) * 1000),
    confidence: 1,
  }));
}

const WINDOW = 6; // words shown around the current word

/** Burned, word-synced captions — crew watch muted in the van, so the words
 *  carry the narration. The active word is highlighted brand-red-bright. */
export const Captions: React.FC<{ captions: Caption[] }> = ({ captions }) => {
  const frame = useCurrentFrame();
  const ms = (frame / FPS) * 1000;

  let active = captions.findIndex((c) => ms >= c.startMs && ms < c.endMs);
  if (active === -1) {
    // Between words: hold the last word that has started.
    for (let i = 0; i < captions.length; i++) if (ms >= captions[i].startMs) active = i;
  }
  if (active === -1) active = 0;

  const half = Math.floor(WINDOW / 2);
  let start = Math.max(0, active - half);
  const end = Math.min(captions.length, start + WINDOW);
  start = Math.max(0, end - WINDOW);
  const shown = captions.slice(start, end);

  return (
    <div
      style={{
        position: "absolute",
        bottom: 70,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        padding: "0 120px",
      }}
    >
      <div
        style={{
          maxWidth: 1400,
          textAlign: "center",
          background: "rgba(15,14,13,0.82)",
          borderRadius: 18,
          padding: "20px 34px",
          fontFamily: sans,
          fontSize: 42,
          fontWeight: 600,
          lineHeight: 1.35,
          color: COLORS.mist300,
          boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
        }}
      >
        {shown.map((c, i) => {
          const idx = start + i;
          const isActive = idx === active;
          return (
            <span
              key={idx}
              style={{
                color: isActive ? COLORS.redBright : COLORS.white,
                opacity: isActive ? 1 : 0.72,
                margin: "0 7px",
                transition: undefined,
              }}
            >
              {c.text}
            </span>
          );
        })}
      </div>
    </div>
  );
};
