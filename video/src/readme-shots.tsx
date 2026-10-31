import { Fragment } from "react";
import { AbsoluteFill } from "remotion";
import { DesktopFrame } from "./components/desktop-frame";
import { PhoneFrame } from "./components/phone-frame";
import { color, sans } from "./theme";

// The README's screenshots: the video's captures in its phone and browser
// frames, rendered as stills into docs/images/screenshots

export const PHONES_SIZE = { width: 1800, height: 1260 };
export const DESKTOP_SIZE = { width: 1800, height: 1120 };
// Taller than the others: six phones still large enough to read at the
// README's width
export const STYLES_SIZE = { width: 1800, height: 2200 };

const Backdrop: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(ellipse at 50% 35%, #1d1f33, ${color.ink} 70%)`,
      alignItems: "center",
      justifyContent: "center",
      fontFamily: sans,
    }}
  >
    {children}
  </AbsoluteFill>
);

// Phones side by side, each named under it
const PhoneRow: React.FC<{ phones: readonly { src: string; label: string }[] }> = ({ phones }) => (
  <Backdrop>
    <div style={{ display: "flex", gap: 90 }}>
      {phones.map((p) => (
        <div
          key={p.src}
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 34 }}
        >
          <PhoneFrame height={1040} screens={[{ at: 0, src: p.src }]} />
          <div style={{ color: color.fg, fontSize: 40, fontWeight: 600 }}>{p.label}</div>
        </div>
      ))}
    </div>
  </Backdrop>
);

export const ReadmePhones: React.FC = () => (
  <PhoneRow
    phones={[
      { src: "phone-terminal", label: "Terminal" },
      { src: "phone-chat", label: "Chat" },
      { src: "phone-diff", label: "Changes" },
    ]}
  />
);

const STYLES = [
  { key: "neutral", label: "Neutral" },
  { key: "terminal", label: "Terminal" },
  { key: "native", label: "Native" },
] as const;
const THEMES = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
] as const;

const label: React.CSSProperties = { color: color.fg, fontSize: 40, fontWeight: 600 };

// Each interface style (columns) in the light and dark theme (rows), on the
// sessions sheet: the screen where the styles differ the most
export const ReadmeStyles: React.FC = () => (
  <Backdrop>
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `140px repeat(${STYLES.length}, auto)`,
        columnGap: 56,
        rowGap: 40,
        alignItems: "center",
        justifyItems: "center",
      }}
    >
      <div />
      {STYLES.map((s) => (
        <div key={s.key} style={label}>
          {s.label}
        </div>
      ))}
      {THEMES.map((t) => (
        <Fragment key={t.key}>
          <div style={{ ...label, justifySelf: "end" }}>{t.label}</div>
          {STYLES.map((s) => (
            <PhoneFrame
              key={s.key}
              height={960}
              screens={[{ at: 0, src: `phone-style-${s.key}-${t.key}` }]}
            />
          ))}
        </Fragment>
      ))}
    </div>
  </Backdrop>
);

// Herdr's workspaces, the Chat view and the Changes panel on a desktop
export const ReadmeDesktop: React.FC = () => (
  <Backdrop>
    <DesktopFrame width={1640} src="desktop-chat-changes" />
  </Backdrop>
);
