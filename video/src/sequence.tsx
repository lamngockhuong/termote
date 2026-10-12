import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Fragment } from "react";
import { Sfx } from "./components/sfx";
import { TRANSITION } from "./theme";

export type Part = { readonly id: string; readonly frames: number; readonly scene: React.FC };

// Total length: the parts overlap by one transition at each cut
export const lengthOf = (parts: readonly Part[]) =>
  parts.reduce((n, p) => n + p.frames, 0) - TRANSITION * (parts.length - 1);

// Frame each part after the first starts at (its fade in)
const cutsOf = (parts: readonly Part[]) =>
  parts.slice(1).map((_, i) => lengthOf(parts.slice(0, i + 1)) - TRANSITION);

// The parts one after another, faded into each other, a whoosh at each cut
export const Sequence: React.FC<{ parts: readonly Part[] }> = ({ parts }) => (
  <>
    {cutsOf(parts).map((at) => (
      <Sfx key={at} sound="whoosh" at={Math.max(at - 4, 0)} />
    ))}
    <TransitionSeries>
    {parts.map((p, i) => (
      <Fragment key={p.id}>
        {i > 0 ? (
          <TransitionSeries.Transition
            presentation={fade()}
            timing={linearTiming({ durationInFrames: TRANSITION })}
          />
        ) : null}
        <TransitionSeries.Sequence durationInFrames={p.frames}>
          <p.scene />
        </TransitionSeries.Sequence>
      </Fragment>
    ))}
    </TransitionSeries>
  </>
);
