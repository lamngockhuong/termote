import { CaptionSwitch } from "../components/caption";
import { DesktopShots } from "../components/desktop-shots";

const SWITCH = 90;

// Blame in the file viewer, then the commit a cell opens; zoomed on the
// Files panel at the window's right (pwa/e2e/capture-video.spec.ts, "desktop blame")
export const BlameScene: React.FC = () => (
  <DesktopShots
    caption={
      <CaptionSwitch
        align="center"
        at={SWITCH}
        first={{ title: "Who changed each line.", sub: "Blame in the file viewer, beside the agent's own edits." }}
        second={{ title: "One click to the commit.", sub: "Its message, author and hash, ready to copy." }}
      />
    }
    shots={[
      { at: 0, src: "desktop-blame", zoom: 2, originX: 100, originY: 96 },
      { at: SWITCH, src: "desktop-blame-commit", zoom: 2, originX: 100, originY: 96 },
    ]}
  />
);
