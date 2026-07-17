import { Composition } from "remotion";
import { CrewTraining, type TrainingProps } from "./Composition";
import { buildTimeline } from "./timeline";
import { FPS, HEIGHT, WIDTH } from "./brand";

export const RemotionRoot: React.FC = () => {
  const { totalF } = buildTimeline();
  return (
    <Composition
      id="CrewTraining"
      component={CrewTraining}
      durationInFrames={totalF}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={{ sha: "dev" } satisfies TrainingProps}
    />
  );
};
