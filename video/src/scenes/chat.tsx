import { Caption } from "../components/caption";
import { PhoneFrame } from "../components/phone-frame";
import { SceneLayout, usePhoneHeight } from "../components/scene-layout";
import { Sfx } from "../components/sfx";

// One turn through the Chat view, as captured: the conversation, the slash
// commands, a message sent, the permission card answered with a tap
export const ChatScene: React.FC = () => {
  const phoneH = usePhoneHeight();
  return (
    <SceneLayout
      caption={
        <Caption
          title="Chat with Claude Code and Codex."
          sub="Read the turn, send the next message, answer its questions with one tap."
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
          { at: 140, src: "phone-chat-permission" },
          { at: 206, src: "phone-chat-done" },
        ]}
        taps={[
          { at: 132, x: 92, y: 96.4 },
          { at: 196, x: 50, y: 78.1 },
        ]}
      />
    </SceneLayout>
  );
};
