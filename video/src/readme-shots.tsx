import { AbsoluteFill } from "remotion";
import { DesktopFrame } from "./components/desktop-frame";
import { PhoneFrame } from "./components/phone-frame";
import { color, sans } from "./theme";

// The README's screenshots: the video's captures in its phone and browser
// frames, rendered as stills into docs/images/screenshots

export const PHONES_SIZE = { width: 1800, height: 1260 };
export const DESKTOP_SIZE = { width: 1800, height: 1120 };

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

export const ReadmeStyles: React.FC = () => (
  <PhoneRow
    phones={[
      { src: "phone-terminal", label: "Neutral" },
      { src: "phone-style-terminal", label: "Terminal" },
      { src: "phone-style-native", label: "Native" },
    ]}
  />
);

// Herdr's workspaces, the Chat view and the Changes panel on a desktop
export const ReadmeDesktop: React.FC = () => (
  <Backdrop>
    <DesktopFrame width={1640} src="desktop-chat-changes" />
  </Backdrop>
);
