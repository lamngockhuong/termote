import { Caption } from "../components/caption";
import { DesktopShots } from "../components/desktop-shots";

// The tab's two panes side by side, the header's Pane menu, then the agent's
// pane zoomed (pwa/e2e/capture-video.spec.ts, "desktop pane menu")
// The menu's shot is zoomed in on the menu, at the window's top right
export const PanesScene: React.FC = () => (
  <DesktopShots
    caption={
      <Caption
        align="center"
        title="Panes side by side."
        sub="Split, zoom, swap and resize them from the Pane menu, on tmux, Herdr and Zellij."
      />
    }
    shots={[
      { at: 0, src: "desktop-terminal" },
      { at: 55, src: "desktop-pane-menu", zoom: 1.6, originX: 82, originY: 10 },
      { at: 110, src: "desktop-pane-zoom" },
    ]}
  />
);
