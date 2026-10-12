import { AbsoluteFill, useCurrentFrame } from "remotion";
import { OwlMark } from "../components/owl-mark";
import { Sfx } from "../components/sfx";
import { appear, color, progress, sans } from "../theme";

// The Prompt Owl, its name and the brand line
export const BrandScene: React.FC = () => {
  const frame = useCurrentFrame();
  const owl = progress(frame, 0, 22);
  return (
    <AbsoluteFill
      style={{
        background: color.ink,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: sans,
      }}
    >
      <Sfx sound="chime" at={4} />
      <div style={{ opacity: owl, transform: `scale(${0.85 + owl * 0.15})` }}>
        <OwlMark size={240} blinkAt={46} />
      </div>
      <div
        style={{
          ...appear(frame, 14),
          marginTop: 44,
          color: color.fg,
          fontSize: 120,
          fontWeight: 700,
          letterSpacing: -4,
          lineHeight: 1,
        }}
      >
        Termote
      </div>
      <div style={{ ...appear(frame, 26), marginTop: 26, color: color.muted, fontSize: 44 }}>
        Your Terminal, Anywhere.
      </div>
    </AbsoluteFill>
  );
};
