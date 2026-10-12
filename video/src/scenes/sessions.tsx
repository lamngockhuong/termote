import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Caption } from "../components/caption";
import { DesktopFrame } from "../components/desktop-frame";
import { color, progress, sans } from "../theme";

const Label: React.FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      position: "absolute",
      top: -26,
      left: 28,
      padding: "8px 22px",
      borderRadius: 99,
      background: color.accent,
      color: "#0b0b1a",
      fontFamily: sans,
      fontSize: 28,
      fontWeight: 700,
      zIndex: 1,
    }}
  >
    {text}
  </div>
);

// Both backends: Herdr's workspaces with each agent's status in front, the
// same chat on tmux sessions behind it
export const SessionsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const herdr = progress(frame, 10, 24);
  const tmux = progress(frame, 56, 24);
  return (
    <AbsoluteFill
      style={{ background: color.ink, alignItems: "center", paddingTop: 70, gap: 60 }}
    >
      <div style={{ width: 1600 }}>
        <Caption
          align="center"
          title="Herdr or tmux. Every agent, one place."
          sub="Herdr workspaces with each agent's status, or your tmux sessions: the same Chat, Files and Changes."
        />
      </div>
      <div style={{ position: "relative", width: 1700, height: 700 }}>
        <div
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            opacity: tmux,
            transform: `translateX(${(1 - tmux) * 120}px)`,
          }}
        >
          <Label text="tmux" />
          <DesktopFrame width={1060} src="desktop-tmux" />
        </div>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 90,
            opacity: herdr,
            transform: `translateY(${(1 - herdr) * 40}px)`,
          }}
        >
          <Label text="Herdr" />
          <DesktopFrame width={1060} src="desktop-chat-changes" />
        </div>
      </div>
    </AbsoluteFill>
  );
};
