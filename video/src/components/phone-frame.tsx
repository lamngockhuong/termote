import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { color } from "../theme";
import { Sfx } from "./sfx";

// A screen of the phone: a capture under public/ui (390×844 CSS pixels, see
// pwa/e2e/capture-video.spec.ts) or any node, shown from frame `at` on.
export type Screen = {
  readonly at: number;
  readonly src?: string;
  readonly node?: React.ReactNode;
};

// A tap on the screen, in percent of its width and height
export type Tap = { readonly at: number; readonly x: number; readonly y: number };

// A box drawn over the screen to point at part of it, in percent
export type Mark = {
  readonly from: number;
  readonly to?: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

const ASPECT = 844 / 390;
const FADE = 8;

type Props = {
  readonly height: number;
  readonly screens: readonly Screen[];
  readonly taps?: readonly Tap[];
  readonly marks?: readonly Mark[];
};

export const PhoneFrame: React.FC<Props> = ({
  height,
  screens,
  taps = [],
  marks = [],
}) => {
  const frame = useCurrentFrame();
  const bezel = height * 0.018;
  const screenH = height - bezel * 2;
  const screenW = screenH / ASPECT;
  const radius = screenW * 0.12;

  return (
    <div
      style={{
        width: screenW + bezel * 2,
        height,
        padding: bezel,
        borderRadius: radius + bezel,
        background: "#2a2a30",
        boxShadow:
          "0 0 0 2px #3a3a42, 0 40px 90px rgba(0,0,0,.55), inset 0 0 0 1px #4a4a52",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          position: "relative",
          width: screenW,
          height: screenH,
          borderRadius: radius,
          overflow: "hidden",
          background: color.surface,
        }}
      >
        {screens.map((s, i) => {
          const next = screens[i + 1];
          // The first screen is there from the start (the hero loops back to it)
          const first = i === 0;
          const opacity =
            (first
              ? 1
              : interpolate(frame, [s.at, s.at + FADE], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })) *
            (next
              ? interpolate(frame, [next.at + FADE, next.at + FADE + 1], [1, 0], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })
              : 1);
          return (
            <div
              key={`${s.at}-${s.src ?? i}`}
              style={{
                position: "absolute",
                inset: 0,
                opacity,
              }}
            >
              {s.src ? (
                <Img
                  src={staticFile(`ui/${s.src}.png`)}
                  style={{ width: "100%", height: "100%", display: "block" }}
                />
              ) : (
                s.node
              )}
            </div>
          );
        })}
        {marks.map((m) => {
          const shown =
            interpolate(frame, [m.from, m.from + 10], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }) *
            (m.to === undefined
              ? 1
              : interpolate(frame, [m.to, m.to + 10], [1, 0], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                }));
          return (
            <div
              key={`m${m.from}`}
              style={{
                position: "absolute",
                left: `${m.x}%`,
                top: `${m.y}%`,
                width: `${m.w}%`,
                height: `${m.h}%`,
                borderRadius: 14,
                border: `3px solid ${color.accent}`,
                boxShadow: `0 0 0 9999px rgba(10,10,14,${0.55 * shown}), 0 0 30px ${color.accent}`,
                opacity: shown,
              }}
            />
          );
        })}
        {taps.map((t) => (
          <Sfx key={`s${t.at}`} sound="tap" at={t.at} />
        ))}
        {taps.map((t) => {
          const p = interpolate(frame, [t.at, t.at + 14], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          if (frame < t.at - 6 || p >= 1) return null;
          const press = interpolate(frame, [t.at - 6, t.at], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          const size = screenW * 0.13;
          return (
            <div
              key={`t${t.at}`}
              style={{
                position: "absolute",
                left: `${t.x}%`,
                top: `${t.y}%`,
                width: size,
                height: size,
                marginLeft: -size / 2,
                marginTop: -size / 2,
                borderRadius: "50%",
                background: "rgba(255,255,255,.35)",
                border: "2px solid rgba(255,255,255,.8)",
                transform: `scale(${0.6 + press * 0.4 + p * 0.8})`,
                opacity: press * (1 - p),
              }}
            />
          );
        })}
      </div>
    </div>
  );
};
