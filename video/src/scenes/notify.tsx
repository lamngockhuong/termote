import { CaptionSwitch } from "../components/caption";
import { LockScreen } from "../components/lock-screen";
import { PhoneFrame } from "../components/phone-frame";
import { SceneLayout, usePhoneHeight } from "../components/scene-layout";

const SWITCH = 90;

export const NotifyScene: React.FC = () => {
  const phoneH = usePhoneHeight();
  return (
    <SceneLayout
      caption={
        <CaptionSwitch
          at={SWITCH}
          first={{ title: "Get pinged when it's done.", sub: "A push when an agent finishes or needs you." }}
          second={{
            title: "Share a view-only device.",
            sub: "A one-time code pairs a tablet or a teammate's phone, without the password.",
          }}
        />
      }
    >
      <PhoneFrame
        height={phoneH}
        screens={[
          {
            at: 0,
            node: <LockScreen at={14} title="Agent finished" body="Claude Code · acme-api / claude" />,
          },
          { at: SWITCH, src: "phone-pair" },
        ]}
      />
    </SceneLayout>
  );
};
