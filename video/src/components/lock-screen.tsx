import { useCurrentFrame } from "remotion";
import { appear, color, sans } from "../theme";
import { OwlMark } from "./owl-mark";
import { Sfx } from "./sfx";

// A phone's lock screen receiving Termote's Web Push. Title and body are the
// ones pwa/src/utils/agent-notify.ts builds: "Agent needs you" or "Agent
// finished", then "<agent> · <group> / <tab>".
type Props = {
  readonly title: string;
  readonly body: string;
  readonly at: number;
};

export const LockScreen: React.FC<Props> = ({ title, body, at }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        background: "radial-gradient(circle at 30% 20%, #2b2d4a, #121218 60%)",
        fontFamily: sans,
        color: color.fg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        containerType: "inline-size",
      }}
    >
      <Sfx sound="ping" at={at} />
      <div style={{ marginTop: "18cqw", fontSize: "24cqw", fontWeight: 700, letterSpacing: "-1cqw", lineHeight: 1.1 }}>
        9:41
      </div>
      <div
        style={{
          ...appear(frame, at, 40),
          marginTop: "10cqw",
          width: "92%",
          padding: "4cqw",
          borderRadius: "6cqw",
          background: "rgba(60,60,72,.72)",
          display: "flex",
          gap: "3.5cqw",
          alignItems: "center",
        }}
      >
        <div
          style={{
            width: "14cqw",
            height: "14cqw",
            borderRadius: "2.6cqw",
            background: color.ink,
            display: "grid",
            placeItems: "center",
            flexShrink: 0,
          }}
        >
          <OwlMark size={40} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "4.8cqw", opacity: 0.7 }}>
            <span>TERMOTE</span>
            <span>now</span>
          </div>
          <div style={{ fontSize: "6cqw", fontWeight: 600, marginTop: "0.6cqw" }}>{title}</div>
          <div style={{ fontSize: "5.4cqw", opacity: 0.85 }}>{body}</div>
        </div>
      </div>
    </div>
  );
};
