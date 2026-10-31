import { useCurrentFrame, useVideoConfig } from "remotion";
import { appear, color, progress, sans } from "../theme";

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

type CaptionText = { readonly title: string; readonly sub?: string };

// Two captions in one place: the first, then the second fading in over it
// from frame `at`, for a scene that makes two points
export const CaptionSwitch: React.FC<{
  readonly first: CaptionText;
  readonly second: CaptionText;
  readonly at: number;
}> = ({ first, second, at }) => {
  const frame = useCurrentFrame();
  const p = progress(frame, at - 8, 10);
  return (
    <div style={{ display: "grid" }}>
      <div style={{ gridArea: "1 / 1", opacity: 1 - p }}>
        <Caption {...first} />
      </div>
      <div style={{ gridArea: "1 / 1", opacity: p }}>
        {frame >= at - 8 ? <Caption at={at - 8} {...second} /> : null}
      </div>
    </div>
  );
};
