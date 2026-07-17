import timelineJson from "../public/timeline.json";
import { FPS } from "./brand";

/** One TTS section as written by crew/tts.mjs. */
export type TtsWord = { text: string; startSec: number; endSec: number };
export type TtsSection = {
  id: string;
  file: string;
  durationSec: number;
  words: TtsWord[];
};

export const sections = timelineJson as TtsSection[];
export const byId = (id: string) => sections.find((s) => s.id === id);
export const secToFrames = (s: number) => Math.round(s * FPS);

/** The 8 body parts, in order, with their on-screen titles + one-line hint. */
export const PARTS: { id: string; n: number; title: string; hint: string; footage: string }[] = [
  { id: "part-1", n: 1, title: "Start your day", hint: "Today is at the top of your list", footage: "footage/part-1.mp4" },
  { id: "part-2", n: 2, title: "Open a job", hint: "Route, crew, van and the item list", footage: "footage/part-2.mp4" },
  { id: "part-3", n: 3, title: "Get there", hint: "One tap opens your maps app", footage: "footage/part-3.mp4" },
  { id: "part-4", n: 4, title: "When you arrive", hint: "Yellow banner? Collect the signature", footage: "footage/part-4.mp4" },
  { id: "part-5", n: 5, title: "During the move", hint: "The red camera button records problems", footage: "footage/part-5.mp4" },
  { id: "part-6", n: 6, title: "Finishing the job", hint: "Both of you sign on the screen", footage: "footage/part-6.mp4" },
  { id: "part-7", n: 7, title: "The job sheet", hint: "One page, no prices, safe in the cab", footage: "footage/part-7.mp4" },
  { id: "part-8", n: 8, title: "Set up your phone", hint: "Install, alerts and fingerprint sign-in", footage: "footage/part-8.mp4" },
];

/** The five-step "how we work" loop shown on the process slide. */
export const PROCESS_STEPS = [
  "Open the app",
  "See today's jobs",
  "Get the route + items",
  "Record any problem",
  "Finish: both sign",
];

const TITLE_SEC = 4;
const OUTRO_SEC = 4.5;
const SLIDE_BEAT_SEC = 2.6; // slide intro before each part's footage

export type Beat =
  | { kind: "title"; from: number; durF: number }
  | { kind: "process"; from: number; durF: number; audio: TtsSection }
  | { kind: "section"; from: number; durF: number; slideF: number; audio: TtsSection; part: (typeof PARTS)[number] }
  | { kind: "recap"; from: number; durF: number; audio: TtsSection }
  | { kind: "outro"; from: number; durF: number };

/** Build the cumulative beat list + total duration in frames. */
export function buildTimeline(): { beats: Beat[]; totalF: number } {
  const beats: Beat[] = [];
  let cursor = 0;

  const titleF = secToFrames(TITLE_SEC);
  beats.push({ kind: "title", from: cursor, durF: titleF });
  cursor += titleF;

  const intro = byId("intro")!;
  const introF = secToFrames(intro.durationSec);
  beats.push({ kind: "process", from: cursor, durF: introF, audio: intro });
  cursor += introF;

  for (const part of PARTS) {
    const audio = byId(part.id)!;
    const durF = secToFrames(audio.durationSec);
    beats.push({
      kind: "section",
      from: cursor,
      durF,
      slideF: secToFrames(SLIDE_BEAT_SEC),
      audio,
      part,
    });
    cursor += durF;
  }

  const recap = byId("recap")!;
  const recapF = secToFrames(recap.durationSec);
  beats.push({ kind: "recap", from: cursor, durF: recapF, audio: recap });
  cursor += recapF;

  const outroF = secToFrames(OUTRO_SEC);
  beats.push({ kind: "outro", from: cursor, durF: outroF });
  cursor += outroF;

  return { beats, totalF: cursor };
}
