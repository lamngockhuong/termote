import QRCode from "qrcode";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { Caption } from "../components/caption";
import { SceneLayout } from "../components/scene-layout";
import { type TermLine, TerminalWindow, typedBy } from "../components/terminal-window";
import { appear, color } from "../theme";

// What install.sh and `termote start` print (scripts/install.sh, cli_start.go)
const INSTALL = "curl -fsSL https://termote.ohnice.app/install.sh | sh";
const lines: TermLine[] = [{ cmd: INSTALL, at: 10 }];
const afterInstall = typedBy(INSTALL, 10) + 6;
lines.push(
  { out: "Downloading Termote 1.20.0 for linux-amd64...", at: afterInstall, tone: "dim" },
  { out: "Signature verified.", at: afterInstall + 10, tone: "dim" },
  { out: "Termote 1.20.0 is installed at ~/.local/share/termote, and nothing is running yet.", at: afterInstall + 18, tone: "dim" },
  { cmd: "termote start --lan", at: afterInstall + 30 },
);
const afterStart = typedBy("termote start --lan", afterInstall + 30) + 8;
lines.push(
  { out: "  [OK] server :7680 - ok", at: afterStart, tone: "ok" },
  { cmd: "termote url --qr", at: afterStart + 16 },
);
const QR_AT = typedBy("termote url --qr", afterStart + 16) + 8;
// An address of the LAN, as `url` prints once the server listens on it
const LINK = "http://192.168.1.20:7680";
lines.push({ out: LINK, at: QR_AT });

// The QR `termote url --qr` shows, drawn from the same link
const QrCard: React.FC<{ size: number; text: string }> = ({ size, text }) => {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = modules.size;
  const quiet = 3;
  const cells: React.ReactNode[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules.get(y, x)) {
        cells.push(<rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1.02} height={1.02} />);
      }
    }
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${n + quiet * 2} ${n + quiet * 2}`}
      style={{ background: "#fff", borderRadius: 20, boxShadow: "0 30px 70px rgba(0,0,0,.5)" }}
    >
      <g fill={color.ink}>{cells}</g>
    </svg>
  );
};

export const InstallScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const portrait = height > width;
  return (
    <SceneLayout
      caption={
        <Caption title="Two commands. One QR code." sub="Install, start on your network, scan it with your phone." />
      }
    >
      <div style={{ position: "relative" }}>
        <TerminalWindow width={portrait ? 920 : 1000} lines={lines} fontSize={24} />
        <div
          style={{
            ...appear(frame, QR_AT + 4, 40),
            position: "absolute",
            right: -40,
            bottom: -90,
          }}
        >
          <QrCard size={260} text={LINK} />
        </div>
      </div>
    </SceneLayout>
  );
};
