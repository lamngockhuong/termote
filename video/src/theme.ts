import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { Easing, interpolate } from "remotion";

// Inter is the face the wordmark was outlined from (docs/brand-identity.md)
export const sans = loadInter("normal", {
  weights: ["400", "600", "700", "800"],
  subsets: ["latin"],
}).fontFamily;
export const mono = loadMono("normal", {
  weights: ["400", "700"],
  subsets: ["latin"],
}).fontFamily;

// Ink and white from the brand, the accent of the PWA's dark Neutral style
export const color = {
  ink: "#101316",
  surface: "#1a1a1d",
  raised: "#232328",
  border: "#2e2e34",
  fg: "#f4f4f5",
  muted: "#a1a1aa",
  accent: "#818cf8",
  green: "#4ade80",
} as const;

export const FPS = 30;
export const TRANSITION = 15;

const ease = Easing.bezier(0.16, 1, 0.3, 1);

// 0 → 1 from `start` over `duration` frames, eased and clamped
export const progress = (frame: number, start: number, duration = 18) =>
  interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });

// Opacity and a short rise, for anything that appears
export const appear = (frame: number, start: number, rise = 24) => {
  const p = progress(frame, start);
  return { opacity: p, transform: `translateY(${(1 - p) * rise}px)` };
};
