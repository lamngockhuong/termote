import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Caption } from "../components/caption";
import { OwlMark } from "../components/owl-mark";
import { appear, color, sans } from "../theme";

// Only what the server does (docs/security-invariants.md)
const CHIPS = [
  "Listens on 127.0.0.1 by default",
  "Password or paired devices",
  "View-only role",
  "Tailscale HTTPS",
  "Signed releases",
];

export const SecurityScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{ background: color.ink, alignItems: "center", justifyContent: "center", gap: 56 }}
    >
      <div style={appear(frame, 0)}>
        <OwlMark size={140} />
      </div>
      <Caption align="center" at={6} title="Private by default." />
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: 22,
          maxWidth: 1300,
          padding: "0 60px",
        }}
      >
        {CHIPS.map((c, i) => (
          <div
            key={c}
            style={{
              ...appear(frame, 20 + i * 8),
              padding: "16px 30px",
              borderRadius: 99,
              border: `2px solid ${color.border}`,
              background: color.surface,
              color: color.fg,
              fontFamily: sans,
              fontSize: 34,
            }}
          >
            {c}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
