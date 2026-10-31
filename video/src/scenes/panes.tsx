import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Caption } from "../components/caption";
import { DesktopFrame } from "../components/desktop-frame";
import { color, progress } from "../theme";

// The tab's two panes side by side, the header's Pane menu, then the agent's
// pane zoomed (pwa/e2e/capture-video.spec.ts, "desktop pane menu")
// The menu's shot is zoomed in on the menu, at the window's top right
const SHOTS = [
  { at: 0, src: "desktop-terminal", zoom: 1 },
  { at: 55, src: "desktop-pane-menu", zoom: 1.6 },
  { at: 110, src: "desktop-pane-zoom", zoom: 1 },
] as const;

const WIDTH = 1300;

export const PanesScene: React.FC = () => {
  const frame = useCurrentFrame();
  const rise = progress(frame, 6, 24);
  return (
    <AbsoluteFill style={{ background: color.ink, alignItems: "center", paddingTop: 70, gap: 50 }}>
      <div style={{ width: 1600 }}>
        <Caption
          align="center"
          title="Panes side by side."
          sub="Split, zoom, swap and resize them from the Pane menu, on tmux, Herdr and Zellij."
        />
      </div>
      <div
        style={{
          position: "relative",
          width: WIDTH,
          opacity: rise,
          transform: `translateY(${(1 - rise) * 40}px)`,
        }}
      >
        {SHOTS.map((s, i) => (
          <div
            key={s.src}
            style={{
              position: i === 0 ? "relative" : "absolute",
              inset: 0,
              opacity: i === 0 ? 1 : progress(frame, s.at, 8),
            }}
          >
            <DesktopFrame width={WIDTH} src={s.src} zoom={s.zoom} originX={82} originY={10} />
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
