import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";
import { COLORS } from "./brand";
import { buildTimeline } from "./timeline";
import { Section } from "./components/Section";
import { Captions, toCaptions } from "./components/Captions";
import { OutroCard, ProcessSlide, RecapSlide, TitleCard } from "./components/Slides";

export type TrainingProps = { sha: string };

/** The crew walkthrough. One <Sequence> per beat; each narration beat also
 *  mounts its own <Audio> so the voice lines up with the visuals exactly. */
export const CrewTraining: React.FC<TrainingProps> = ({ sha }) => {
  const { beats } = buildTimeline();

  return (
    <AbsoluteFill style={{ background: COLORS.charcoal }}>
      {beats.map((beat, i) => {
        const key = `${beat.kind}-${i}`;
        if (beat.kind === "title") {
          return (
            <Sequence key={key} from={beat.from} durationInFrames={beat.durF} name="Title">
              <TitleCard />
            </Sequence>
          );
        }
        if (beat.kind === "process") {
          return (
            <Sequence key={key} from={beat.from} durationInFrames={beat.durF} name="Process">
              <Audio src={staticFile(`audio/${beat.audio.file}`)} />
              <ProcessSlide />
              <Captions captions={toCaptions(beat.audio.words)} />
            </Sequence>
          );
        }
        if (beat.kind === "section") {
          return (
            <Sequence key={key} from={beat.from} durationInFrames={beat.durF} name={beat.part.title}>
              <Audio src={staticFile(`audio/${beat.audio.file}`)} />
              <Section beat={beat} />
            </Sequence>
          );
        }
        if (beat.kind === "recap") {
          return (
            <Sequence key={key} from={beat.from} durationInFrames={beat.durF} name="Recap">
              <Audio src={staticFile(`audio/${beat.audio.file}`)} />
              <RecapSlide />
              <Captions captions={toCaptions(beat.audio.words)} />
            </Sequence>
          );
        }
        return (
          <Sequence key={key} from={beat.from} durationInFrames={beat.durF} name="Outro">
            <OutroCard sha={sha} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
