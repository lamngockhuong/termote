import { CaptionSwitch } from "../components/caption";
import { PhoneFrame } from "../components/phone-frame";
import { SceneLayout, usePhoneHeight } from "../components/scene-layout";

const SWITCH = 120;

// The pane's session history: the folder's earlier sessions with this
// week's tokens and cost, then one of them opened (pwa/e2e/capture-video.spec.ts,
// "phone session history")
export const HistoryScene: React.FC = () => {
  const phoneH = usePhoneHeight();
  return (
    <SceneLayout
      caption={
        <CaptionSwitch
          at={SWITCH}
          first={{
            title: "Pick up any session again.",
            sub: "Every Claude Code and Codex session of the folder: resume it, fork it, see the files it changed.",
          }}
          second={{
            title: "Know what it costs.",
            sub: "Tokens and an estimated cost for each session, today and this week.",
          }}
        />
      }
    >
      <PhoneFrame
        height={phoneH}
        screens={[
          { at: 0, src: "phone-history" },
          { at: 100, src: "phone-history-session" },
        ]}
        taps={[{ at: 92, x: 50, y: 87.8 }]}
        marks={[
          { from: 30, to: 84, x: 0, y: 77.5, w: 100, h: 22 },
          { from: SWITCH + 10, x: 1.5, y: 25, w: 97, h: 6.2 },
        ]}
      />
    </SceneLayout>
  );
};
