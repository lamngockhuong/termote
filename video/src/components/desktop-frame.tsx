import { Img, staticFile } from "remotion";
import { color, sans } from "../theme";

// A browser window around a desktop capture (1600×900 CSS pixels)
type Props = {
  readonly width: number;
  readonly src: string;
  // Zoom into the capture around (originX, originY) in percent
  readonly zoom?: number;
  readonly originX?: number;
  readonly originY?: number;
};

export const DesktopFrame: React.FC<Props> = ({
  width,
  src,
  zoom = 1,
  originX = 50,
  originY = 50,
}) => {
  const bar = width * 0.028;
  return (
    <div
      style={{
        width,
        borderRadius: width * 0.012,
        overflow: "hidden",
        background: color.surface,
        boxShadow: `0 0 0 1px ${color.border}, 0 40px 90px rgba(0,0,0,.55)`,
      }}
    >
      <div
        style={{
          height: bar,
          display: "flex",
          alignItems: "center",
          gap: bar * 0.3,
          padding: `0 ${bar * 0.5}px`,
          background: color.raised,
        }}
      >
        {["#ff605c", "#ffbd44", "#00ca4e"].map((c) => (
          <span
            key={c}
            style={{ width: bar * 0.32, height: bar * 0.32, borderRadius: 99, background: c }}
          />
        ))}
        <span
          style={{
            marginLeft: bar * 0.6,
            padding: `${bar * 0.08}px ${bar * 0.5}px`,
            borderRadius: 99,
            background: color.surface,
            color: color.muted,
            fontFamily: sans,
            fontSize: bar * 0.42,
          }}
        >
          127.0.0.1:7680
        </span>
      </div>
      <div style={{ width, height: (width * 900) / 1600, overflow: "hidden" }}>
        <Img
          src={staticFile(`ui/${src}.png`)}
          style={{
            width: "100%",
            display: "block",
            transform: `scale(${zoom})`,
            transformOrigin: `${originX}% ${originY}%`,
          }}
        />
      </div>
    </div>
  );
};
