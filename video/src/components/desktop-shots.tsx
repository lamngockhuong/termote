import { AbsoluteFill, useCurrentFrame } from "remotion";
import { color, progress } from "../theme";
import { DesktopFrame } from "./desktop-frame";

export type DesktopShot = {
  readonly at: number;
  readonly src: string;
  // Zoomed in around (originX, originY), in percent of the capture
  readonly zoom?: number;
  readonly originX?: number;
  readonly originY?: number;
};

type Props = {
  readonly caption: React.ReactNode;
  readonly shots: readonly DesktopShot[];
  readonly width?: number;
};

// A desktop scene: the caption on top, a browser window under it whose
// captures fade one into the next at their frame
export const DesktopShots: React.FC<Props> = ({ caption, shots, width = 1300 }) => {
  const frame = useCurrentFrame();
  const rise = progress(frame, 6, 24);
  return (
    <AbsoluteFill style={{ background: color.ink, alignItems: "center", paddingTop: 70, gap: 50 }}>
      <div style={{ width: 1600 }}>{caption}</div>
      <div
        style={{
          position: "relative",
          width,
          opacity: rise,
          transform: `translateY(${(1 - rise) * 40}px)`,
        }}
      >
        {shots.map((s, i) => (
          <div
            key={s.src}
            style={{
              position: i === 0 ? "relative" : "absolute",
              inset: 0,
              opacity: i === 0 ? 1 : progress(frame, s.at, 8),
            }}
          >
            <DesktopFrame
              width={width}
              src={s.src}
              zoom={s.zoom}
              originX={s.originX}
              originY={s.originY}
            />
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
