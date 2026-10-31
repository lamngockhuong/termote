import { AbsoluteFill } from "remotion";
import { DesktopFrame } from "./components/desktop-frame";
import { PhoneFrame } from "./components/phone-frame";
import { color } from "./theme";

export const HERO_FRAMES = 450;

// The website's hero: no words (the page has them), a loop that ends on the
// screen it starts with
export const Hero: React.FC = () => (
  <AbsoluteFill
    style={{
      background: color.ink,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 0,
    }}
  >
    <div style={{ opacity: 0.9 }}>
      <DesktopFrame width={1300} src="desktop-chat-changes" />
    </div>
    <div style={{ marginLeft: -260, marginTop: 120 }}>
      <PhoneFrame
        height={860}
        screens={[
          { at: 0, src: "phone-chat" },
          { at: 70, src: "phone-chat-typed" },
          { at: 110, src: "phone-chat-permission" },
          { at: 180, src: "phone-chat-done" },
          { at: 250, src: "phone-diff" },
          { at: 330, src: "phone-terminal" },
          { at: 420, src: "phone-chat" },
        ]}
        taps={[
          { at: 102, x: 92, y: 96.4 },
          { at: 170, x: 50, y: 79.4 },
        ]}
      />
    </div>
  </AbsoluteFill>
);
