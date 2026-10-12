import { useCurrentFrame } from "remotion";
import { Caption } from "../components/caption";
import { PhoneFrame } from "../components/phone-frame";
import { Sfx } from "../components/sfx";
import { SceneLayout, usePhoneHeight } from "../components/scene-layout";
import { color, mono, progress } from "../theme";

// Gestures from pwa/src/hooks/use-gestures.ts
const Gesture: React.FC<{ at: number; label: string; dir: 1 | -1 }> = ({ at, label, dir }) => {
  const frame = useCurrentFrame();
  const p = progress(frame, at, 24);
  const out = progress(frame, at + 34, 10);
  return (
    <div
      style={{
        position: "absolute",
        top: "42%",
        left: "50%",
        opacity: Math.min(p * 3, 1) * (1 - out),
        transform: `translateX(calc(-50% + ${dir * (p - 0.5) * 220}px))`,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 18,
      }}
    >
      <div
        style={{
          width: 70,
          height: 70,
          borderRadius: 99,
          background: "rgba(255,255,255,.3)",
          border: "3px solid rgba(255,255,255,.85)",
        }}
      />
      <div
        style={{
          padding: "8px 18px",
          borderRadius: 12,
          background: color.accent,
          color: "#0b0b1a",
          fontFamily: mono,
          fontSize: 26,
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
    </div>
  );
};

export const TerminalScene: React.FC = () => {
  const phoneH = usePhoneHeight();
  return (
    <SceneLayout
      caption={
        <Caption
          title="A real terminal, built for thumbs."
          sub="Any shell, any CLI agent. Keys for Esc, Ctrl and arrows; swipe left for Ctrl+C, right for Tab."
        />
      }
    >
      <div style={{ position: "relative" }}>
        <PhoneFrame
          height={phoneH}
          screens={[{ at: 0, src: "phone-terminal" }]}
          marks={[{ from: 40, to: 110, x: 1.5, y: 92.6, w: 97, h: 6.8 }]}
        />
        <Gesture at={120} label="← Ctrl+C" dir={-1} />
        <Gesture at={168} label="Tab →" dir={1} />
        <Sfx sound="whoosh" at={118} />
        <Sfx sound="whoosh" at={166} />
      </div>
    </SceneLayout>
  );
};
