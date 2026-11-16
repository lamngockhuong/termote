import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Caption } from "../components/caption";
import { PhoneFrame } from "../components/phone-frame";
import { appear, color, sans } from "../theme";

const STYLES = [
  { key: "neutral", label: "Neutral" },
  { key: "terminal", label: "Terminal" },
  { key: "native", label: "Native" },
] as const;

// When each phone turns from light to dark, one after the other
const DARK_AT = 80;

// The three interface styles on the sessions sheet, light, then each
// turning dark (pwa/e2e/capture-video.spec.ts, "phone sessions in each style
// and theme"), and Settings' export and import beside them
export const ThemesScene: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: color.ink, alignItems: "center", paddingTop: 70, gap: 50 }}>
      <div style={{ width: 1600 }}>
        <Caption
          align="center"
          title="Light or dark, three styles."
          sub="Neutral, Terminal or Native. Export your settings, import them in another browser."
        />
      </div>
      <div style={{ display: "flex", gap: 64 }}>
        {[...STYLES, { key: "export", label: "Export & import" } as const].map((s, i) => (
          <div
            key={s.key}
            style={{
              ...appear(frame, 10 + i * 6),
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 22,
            }}
          >
            <PhoneFrame
              height={700}
              screens={
                s.key === "export"
                  ? [{ at: 0, src: "phone-settings-export" }]
                  : [
                      { at: 0, src: `phone-style-${s.key}-light` },
                      { at: DARK_AT + i * 14, src: `phone-style-${s.key}-dark` },
                    ]
              }
            />
            <div style={{ color: color.fg, fontFamily: sans, fontSize: 32, fontWeight: 600 }}>{s.label}</div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
