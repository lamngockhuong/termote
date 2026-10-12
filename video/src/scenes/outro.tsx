import { AbsoluteFill, useCurrentFrame } from "remotion";
import { OwlMark } from "../components/owl-mark";
import { Sfx } from "../components/sfx";
import { appear, color, mono, sans } from "../theme";

export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        background: color.ink,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: sans,
        textAlign: "center",
        padding: "0 60px",
      }}
    >
      <Sfx sound="chime" at={2} />
      <div style={appear(frame, 0)}>
        <OwlMark size={170} blinkAt={70} />
      </div>
      <div
        style={{
          ...appear(frame, 8),
          marginTop: 36,
          color: color.fg,
          fontSize: 92,
          fontWeight: 800,
          letterSpacing: -3,
          lineHeight: 1.05,
        }}
      >
        Your Terminal, Anywhere.
      </div>
      <div
        style={{
          ...appear(frame, 18),
          marginTop: 48,
          padding: "20px 34px",
          borderRadius: 16,
          background: color.surface,
          border: `1px solid ${color.border}`,
          color: color.fg,
          fontFamily: mono,
          fontSize: 32,
        }}
      >
        <span style={{ color: color.green }}>$ </span>
        curl -fsSL https://termote.ohnice.app/install.sh | sh
      </div>
      <div style={{ ...appear(frame, 28), marginTop: 40, color: color.muted, fontSize: 36 }}>
        <span style={{ color: color.fg, fontWeight: 600 }}>termote.ohnice.app</span>
        {"  ·  "}Open source, MIT
      </div>
    </AbsoluteFill>
  );
};
