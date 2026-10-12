import { AbsoluteFill, useVideoConfig } from "remotion";
import { color } from "../theme";

type Props = {
  readonly caption: React.ReactNode;
  readonly children: React.ReactNode;
};

// Caption beside the picture in landscape, above it in portrait
export const SceneLayout: React.FC<Props> = ({ caption, children }) => {
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  return (
    <AbsoluteFill
      style={{
        background: color.ink,
        flexDirection: portrait ? "column" : "row",
        alignItems: "center",
        justifyContent: portrait ? "flex-start" : "center",
        padding: portrait ? "150px 80px 0" : "0 120px",
        gap: portrait ? 70 : 110,
      }}
    >
      <div style={{ width: portrait ? "100%" : 680, flexShrink: 0 }}>{caption}</div>
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: portrait ? "flex-start" : "center",
          justifyContent: "center",
          minWidth: 0,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};

// The phone's height that fits beside (or under) a caption
export const usePhoneHeight = () => {
  const { width, height } = useVideoConfig();
  return height > width ? 1280 : 980;
};
