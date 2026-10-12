import { interpolate, useCurrentFrame } from "remotion";
import { color } from "../theme";

// The Prompt Owl, from assets/branding/termote/logo/symbol.svg: the body, and
// the eyes and beak cut out of it. The eyes are drawn on their own so they can
// blink (a squash on their centre line); the silhouette is never redrawn.
const BODY =
  "M28 20 L166 62 L304 20 L282 68 L297 91 L286 203 Q283 226 261 237 L166 280 L71 237 Q49 226 46 203 L35 91 L50 68 Z";
const EYES =
  "M68 103 L112 135 L68 167 L68 146 L88 135 L68 124 ZM264 103 L220 135 L264 167 L264 146 L244 135 L264 124 Z";
const BEAK = "M145 175 L187 175 L166 211 Z";

type Props = {
  readonly size: number;
  // Frame at which the eyes blink once, if any
  readonly blinkAt?: number;
  readonly fill?: string;
  readonly cutout?: string;
};

export const OwlMark: React.FC<Props> = ({
  size,
  blinkAt,
  fill = color.fg,
  cutout = color.ink,
}) => {
  const frame = useCurrentFrame();
  const eyeScale =
    blinkAt === undefined
      ? 1
      : interpolate(
          frame,
          [blinkAt, blinkAt + 3, blinkAt + 6],
          [1, 0.12, 1],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        );
  return (
    <svg
      viewBox="28 20 276 260"
      width={size}
      height={(size * 260) / 276}
      aria-hidden="true"
    >
      <path d={BODY} fill={fill} />
      <g transform={`translate(0 135) scale(1 ${eyeScale}) translate(0 -135)`}>
        <path d={EYES} fill={cutout} />
      </g>
      <path d={BEAK} fill={cutout} />
    </svg>
  );
};
