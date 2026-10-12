import { useCurrentFrame } from "remotion";
import { color, mono, sans } from "../theme";
import { Sfx } from "./sfx";

// A line of the terminal: a command typed from `at`, or output shown at `at`
export type TermLine =
  | { readonly cmd: string; readonly at: number }
  | { readonly out: string; readonly at: number; readonly tone?: "ok" | "dim" };

const CHARS_PER_FRAME = 1.6;

// When a command started at `at` is fully typed
export const typedBy = (cmd: string, at: number) => at + Math.ceil(cmd.length / CHARS_PER_FRAME);

type Props = {
  readonly width: number;
  readonly lines: readonly TermLine[];
  readonly fontSize?: number;
};

export const TerminalWindow: React.FC<Props> = ({ width, lines, fontSize = 26 }) => {
  const frame = useCurrentFrame();
  const shown = lines.filter((l) => frame >= l.at);
  const last = shown[shown.length - 1];
  return (
    <div
      style={{
        width,
        borderRadius: 18,
        overflow: "hidden",
        background: "#0b0b0e",
        boxShadow: `0 0 0 1px ${color.border}, 0 40px 90px rgba(0,0,0,.55)`,
      }}
    >
      <div
        style={{
          height: 50,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 20px",
          background: color.raised,
          color: color.muted,
          fontFamily: sans,
          fontSize: 18,
        }}
      >
        {["#ff605c", "#ffbd44", "#00ca4e"].map((c) => (
          <span key={c} style={{ width: 13, height: 13, borderRadius: 99, background: c }} />
        ))}
        <span style={{ marginLeft: 14 }}>dev@laptop: ~</span>
      </div>
      <div
        style={{
          padding: "28px 32px",
          minHeight: 420,
          fontFamily: mono,
          fontSize,
          lineHeight: 1.55,
          color: color.fg,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {lines.map((l) =>
          "cmd" in l ? (
            <Sfx key={`k${l.at}`} sound="typing" at={l.at} frames={typedBy(l.cmd, l.at) - l.at} />
          ) : null,
        )}
        {shown.map((l, i) => {
          if ("cmd" in l) {
            const n = Math.floor((frame - l.at) * CHARS_PER_FRAME);
            const typing = l === last;
            return (
              <div key={i}>
                <span style={{ color: color.green }}>$ </span>
                {l.cmd.slice(0, n)}
                {typing ? (
                  <span style={{ opacity: frame % 20 < 10 ? 1 : 0, color: color.accent }}>▋</span>
                ) : null}
              </div>
            );
          }
          return (
            <div
              key={i}
              style={{
                color: l.tone === "ok" ? color.green : l.tone === "dim" ? color.muted : color.fg,
              }}
            >
              {l.out}
            </div>
          );
        })}
      </div>
    </div>
  );
};
