// Width of the drawing: one unit per slot of a full history
const WIDTH = 179
const HEIGHT = 40

interface Props {
  // Values oldest first, 0 to max; null leaves a gap
  values: readonly (number | null)[]
  // How many values a full line holds: fewer are drawn from the right
  slots: number
  // Read by a screen reader: what the line shows ("CPU, last 15 min: ...")
  label: string
  max?: number
  className?: string
}

// x and y of each value in the drawing, null where there is none
export function sparkPoints(
  values: readonly (number | null)[],
  slots: number,
  max = 100,
): ([number, number] | null)[] {
  const step = WIDTH / Math.max(slots - 1, 1)
  const first = Math.max(slots - values.length, 0)
  return values.slice(-slots).map((v, i) => {
    if (v === null || !Number.isFinite(v)) return null
    const y = HEIGHT - (Math.min(Math.max(v, 0), max) / max) * HEIGHT
    return [round((first + i) * step), round(y)]
  })
}

// Runs of points without a gap, each drawn as one polyline
export function sparkRuns(points: ([number, number] | null)[]): string[] {
  const runs: string[] = []
  let run: [number, number][] = []
  const flush = () => {
    if (run.length === 1) {
      // A lone point gets a short dash, so it shows
      const [x, y] = run[0]
      run = [[Math.max(x - 1, 0), y], run[0]]
    }
    if (run.length) runs.push(run.map(([x, y]) => `${x},${y}`).join(' '))
    run = []
  }
  for (const p of points) {
    if (p) run.push(p)
    else flush()
  }
  flush()
  return runs
}

const round = (n: number) => Math.round(n * 10) / 10

// A line of the last values, drawn as plain SVG (no chart library, nothing
// animated). Its colour is the text colour of its parent.
export function Sparkline({
  values,
  slots,
  label,
  max = 100,
  className,
}: Props) {
  const runs = sparkRuns(sparkPoints(values, slots, max))
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={`block h-10 w-full ${className ?? ''}`}
    >
      <line
        x1={0}
        x2={WIDTH}
        y1={HEIGHT - 0.5}
        y2={HEIGHT - 0.5}
        className="stroke-border"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {runs.map((pts) => (
        <polyline
          key={pts}
          points={pts}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  )
}
