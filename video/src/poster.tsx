import { AbsoluteFill } from "remotion";
import { Hero } from "./hero";
import { color, sans } from "./theme";

// The README's picture of the intro: the hero's first frame, dimmed, with a
// play button and the length, linking to the video
export const Poster: React.FC = () => (
  <AbsoluteFill>
    <Hero />
    <AbsoluteFill
      style={{
        background: "rgba(10,10,14,.45)",
        alignItems: "center",
        justifyContent: "center",
        gap: 36,
        fontFamily: sans,
      }}
    >
      <div
        style={{
          width: 220,
          height: 220,
          borderRadius: "50%",
          background: color.accent,
          display: "grid",
          placeItems: "center",
          boxShadow: "0 30px 80px rgba(0,0,0,.6)",
        }}
      >
        <svg width="96" height="96" viewBox="0 0 24 24" style={{ marginLeft: 14 }}>
          <path d="M6 3.5v17a1 1 0 0 0 1.5.86l14-8.5a1 1 0 0 0 0-1.72l-14-8.5A1 1 0 0 0 6 3.5Z" fill="#0b0b1a" />
        </svg>
      </div>
      <div
        style={{
          padding: "14px 34px",
          borderRadius: 99,
          background: "rgba(16,19,22,.85)",
          color: color.fg,
          fontSize: 48,
          fontWeight: 700,
        }}
      >
        Termote in a minute
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
);
