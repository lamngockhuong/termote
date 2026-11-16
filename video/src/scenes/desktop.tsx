import { CaptionSwitch } from "../components/caption";
import { DesktopShots } from "../components/desktop-shots";

const SWITCH = 120;

// The compact sidebar with the toolbar on the right, then a right click in
// Files (pwa/e2e/capture-video.spec.ts, "desktop compact" and "desktop context menu")
export const DesktopScene: React.FC = () => (
  <DesktopShots
    caption={
      <CaptionSwitch
        align="center"
        at={SWITCH}
        first={{
          title: "A desktop layout your way.",
          sub: "A compact or detailed sidebar you can resize, the toolbar in the header or on the right.",
        }}
        second={{ title: "Right-click for more.", sub: "Copy a path, rename, download, or open a file in Windows." }}
      />
    }
    shots={[
      { at: 0, src: "desktop-compact" },
      { at: SWITCH, src: "desktop-context-menu" },
    ]}
  />
);
