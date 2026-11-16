import { CaptionSwitch } from "../components/caption";
import { DesktopShots } from "../components/desktop-shots";

const SWITCH = 120;

// Another computer's Termote in the sidebar, then the host's numbers
// (pwa/e2e/capture-video.spec.ts, "desktop machine" and "desktop host")
export const MachinesScene: React.FC = () => (
  <DesktopShots
    caption={
      <CaptionSwitch
        align="center"
        at={SWITCH}
        first={{
          title: "All your machines, one sidebar.",
          sub: "Reach the Termote of another computer over SSH: its sessions, Files and Changes.",
        }}
        second={{ title: "Keep an eye on the host.", sub: "CPU, memory, disks and battery, a tap away in the header." }}
      />
    }
    shots={[
      { at: 0, src: "desktop-machine" },
      { at: SWITCH, src: "desktop-host" },
    ]}
  />
);
