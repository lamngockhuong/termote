import { CaptionSwitch } from "../components/caption";
import { PhoneFrame } from "../components/phone-frame";
import { SceneLayout, usePhoneHeight } from "../components/scene-layout";

const SWITCH = 70;

// The repo's tasks (make targets and go.mod's Go tasks), then the sessions
// sheet in English and in Vietnamese
export const TasksScene: React.FC = () => {
  const phoneH = usePhoneHeight();
  return (
    <SceneLayout
      caption={
        <CaptionSwitch
          at={SWITCH}
          first={{
            title: "Run the project's tasks.",
            sub: "npm, make, Go, Gradle, Maven, Cargo and more: one tap, in a tab of its own.",
          }}
          second={{ title: "Tiếng Việt, too.", sub: "The whole app in English or Vietnamese, picked in Settings." }}
        />
      }
    >
      <PhoneFrame
        height={phoneH}
        screens={[
          { at: 0, src: "phone-tasks" },
          { at: SWITCH, src: "phone-sessions" },
          { at: SWITCH + 35, src: "phone-sessions-vi" },
        ]}
        marks={[{ from: SWITCH + 12, x: 3.2, y: 22.6, w: 93.6, h: 6.5 }]}
      />
    </SceneLayout>
  );
};
