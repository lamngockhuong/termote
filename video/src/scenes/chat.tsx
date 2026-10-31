import { Caption } from "../components/caption";
import { PhoneFrame } from "../components/phone-frame";
import { SceneLayout, usePhoneHeight } from "../components/scene-layout";
import { Sfx } from "../components/sfx";

// One turn through the Chat view, as captured: the conversation, the slash
// commands, a message sent, the agent's working row, the permission card
// answered with a tap
export const ChatScene: React.FC = () => {
  const phoneH = usePhoneHeight();
  return (
    <SceneLayout
      caption={
        <Caption
          title="Chat with Claude Code and Codex."
          sub="Send the next message, see that it works, answer its questions with one tap."
        />
      }
    >
      <Sfx sound="typing" at={66} frames={32} />
      <PhoneFrame
        height={phoneH}
        screens={[
          { at: 0, src: "phone-chat" },
          { at: 56, src: "phone-chat-commands" },
          { at: 100, src: "phone-chat-typed" },
          { at: 140, src: "phone-chat-working" },
          { at: 180, src: "phone-chat-permission" },
          { at: 236, src: "phone-chat-done" },
        ]}
        taps={[
          { at: 132, x: 92, y: 96.4 },
          { at: 226, x: 50, y: 79.4 },
        ]}
        marks={[{ from: 146, to: 172, x: 1.5, y: 83.2, w: 97, h: 3.8 }]}
      />
    </SceneLayout>
  );
};
