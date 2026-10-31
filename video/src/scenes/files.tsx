import { CaptionSwitch } from "../components/caption";
import { PhoneFrame } from "../components/phone-frame";
import { SceneLayout, usePhoneHeight } from "../components/scene-layout";

const SWITCH = 75;

// A file sent from the phone into the pane's folder, then deleted and found
// again in the trash (pwa/e2e/capture-video.spec.ts, "phone upload and trash")
export const FilesScene: React.FC = () => {
  const phoneH = usePhoneHeight();
  return (
    <SceneLayout
      caption={
        <CaptionSwitch
          at={SWITCH}
          first={{ title: "Send files from your phone.", sub: "Upload with a button, a drop or a paste." }}
          second={{ title: "Deleted by mistake?", sub: "It waits in the trash: restore it, or delete it for good." }}
        />
      }
    >
      <PhoneFrame
        height={phoneH}
        screens={[
          { at: 0, src: "phone-files-upload" },
          { at: SWITCH, src: "phone-files-trash" },
        ]}
        marks={[
          { from: 14, to: 62, x: 0, y: 43.8, w: 100, h: 5.2 },
          { from: SWITCH + 14, x: 1.5, y: 84, w: 97, h: 8.4 },
        ]}
      />
    </SceneLayout>
  );
};
