import { Caption } from "../components/caption";
import { PhoneFrame } from "../components/phone-frame";
import { SceneLayout, usePhoneHeight } from "../components/scene-layout";

export const ChangesScene: React.FC = () => {
  const phoneH = usePhoneHeight();
  return (
    <SceneLayout
      caption={
        <Caption
          title="See exactly what changed."
          sub="Browse the files, preview Markdown and diagrams, review the agent's diff."
        />
      }
    >
      <PhoneFrame
        height={phoneH}
        screens={[
          { at: 0, src: "phone-files" },
          { at: 80, src: "phone-changes" },
          { at: 130, src: "phone-diff" },
        ]}
        taps={[{ at: 122, x: 40, y: 25.1 }]}
      />
    </SceneLayout>
  );
};
