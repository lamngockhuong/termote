import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Caption } from "../components/caption";
import { DesktopFrame } from "../components/desktop-frame";
import { LockScreen } from "../components/lock-screen";
import { PhoneFrame } from "../components/phone-frame";
import { usePhoneHeight } from "../components/scene-layout";
import { color, progress } from "../theme";

// The agent at the desk stops to ask; the phone in a pocket gets the push
export const HookScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  const phoneH = usePhoneHeight();
  const desk = progress(frame, 0, 30);
  const away = progress(frame, 34, 24);
  const phoneIn = progress(frame, 30, 26);
  return (
    <AbsoluteFill style={{ background: color.ink }}>
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          opacity: desk * (1 - away * 0.75),
          filter: `blur(${away * 6}px)`,
          transform: `scale(${1.04 - desk * 0.04})`,
        }}
      >
        <DesktopFrame width={portrait ? 980 : 1500} src="desktop-terminal" />
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          flexDirection: portrait ? "column" : "row",
          alignItems: "center",
          justifyContent: "center",
          gap: portrait ? 60 : 140,
          padding: portrait ? "120px 80px" : "0 120px",
        }}
      >
        <div style={{ width: portrait ? "100%" : 640, opacity: away }}>
          <Caption at={40} title="Your agent is waiting." sub="And you're not at your desk." />
        </div>
        <div style={{ transform: `translateY(${(1 - phoneIn) * 700}px)` }}>
          <PhoneFrame
            height={phoneH}
            screens={[
              {
                at: 0,
                node: (
                  <LockScreen at={52} title="Agent needs you" body="Claude Code · acme-api / claude" />
                ),
              },
            ]}
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
