import { Caption } from "../components/caption";
import { PhoneFrame } from "../components/phone-frame";
import { SceneLayout, usePhoneHeight } from "../components/scene-layout";

// An OpenCode pane's Chat view, a shell command waiting for permission
// (pwa/e2e/capture-video.spec.ts, "phone opencode chat")
export const OpencodeScene: React.FC = () => {
  const phoneH = usePhoneHeight();
  return (
    <SceneLayout
      caption={
        <Caption
          title="OpenCode, too."
          sub="Its status, its chat, slash commands and permission answers, the same way from your phone."
        />
      }
    >
      <PhoneFrame
        height={phoneH}
        screens={[{ at: 0, src: "phone-opencode-permission" }]}
        marks={[{ from: 50, x: 1.5, y: 65.6, w: 97, h: 26.6 }]}
      />
    </SceneLayout>
  );
};
