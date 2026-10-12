import { Audio } from "@remotion/media";
import { interpolate, Sequence, staticFile, useVideoConfig } from "remotion";

// Sounds made by audio/make-audio.mjs into public/audio
export type Sound = "typing" | "tap" | "ping" | "chime" | "whoosh";

const LEVEL: Record<Sound, number> = {
  typing: 0.6,
  tap: 0.7,
  ping: 0.6,
  chime: 0.45,
  whoosh: 0.25,
};

// A sound from frame `at`, cut after `frames` when given
export const Sfx: React.FC<{ sound: Sound; at: number; frames?: number }> = ({
  sound,
  at,
  frames,
}) => (
  <Sequence from={at} durationInFrames={frames} layout="none">
    <Audio src={staticFile(`audio/${sound}.wav`)} volume={LEVEL[sound]} />
  </Sequence>
);

// The music under a whole composition, faded in and out at its ends
export const Music: React.FC = () => {
  const { durationInFrames } = useVideoConfig();
  return (
    <Audio
      src={staticFile("audio/music.wav")}
      volume={(f) =>
        0.55 *
        interpolate(f, [0, 12, durationInFrames - 60, durationInFrames - 1], [0, 1, 1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      }
    />
  );
};
