import { useCurrentFrame } from "remotion";
import { Caption } from "../components/caption";
import { LockScreen } from "../components/lock-screen";
import { PhoneFrame } from "../components/phone-frame";
import { SceneLayout, usePhoneHeight } from "../components/scene-layout";
import { progress } from "../theme";

const SWITCH = 100;

export const NotifyScene: React.FC = () => {
  const frame = useCurrentFrame();
  const phoneH = usePhoneHeight();
  const second = progress(frame, SWITCH - 8, 10);
  return (
    <SceneLayout
      caption={
        <div style={{ display: "grid" }}>
          <div style={{ gridArea: "1 / 1", opacity: 1 - second }}>
            <Caption title="Get pinged when it's done." sub="A push when an agent finishes or needs you." />
          </div>
          <div style={{ gridArea: "1 / 1", opacity: second }}>
            {frame >= SWITCH - 8 ? (
              <Caption
                at={SWITCH - 8}
                title="Share a view-only device."
                sub="A one-time code pairs a tablet or a teammate's phone, without the password."
              />
            ) : null}
          </div>
        </div>
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
