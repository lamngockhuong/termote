import { useCurrentFrame, useVideoConfig } from "remotion";
import { appear, color, sans } from "../theme";

type Props = {
  readonly title: string;
  readonly sub?: string;
  readonly at?: number;
  readonly align?: "left" | "center";
};

// The headline of a scene and its one line of detail. Every idea of the video
// is written here, so it reads with the sound off (and leaves room for a
// voice-over later).
export const Caption: React.FC<Props> = ({ title, sub, at = 6, align = "left" }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  return (
    <div style={{ textAlign: align, fontFamily: sans }}>
      <div
        style={{
          ...appear(frame, at),
          color: color.fg,
          fontSize: portrait ? 78 : 72,
          fontWeight: 800,
          letterSpacing: -2.5,
          lineHeight: 1.05,
        }}
      >
        {title}
      </div>
      {sub ? (
        <div
          style={{
            ...appear(frame, at + 8),
            marginTop: 26,
            color: color.muted,
            fontSize: portrait ? 40 : 34,
            lineHeight: 1.35,
            fontWeight: 400,
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  );
};
