import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'
import type { SubagentNode, Subagents } from '../hooks/use-mux-api'

// At most this many subagents are drawn; the rest are counted.
export const SUBAGENT_TREE_MAX = 20

// Each status has its own icon; a running one glows slowly (opacity only),
// still when the user asks for reduced motion.
const NODE_STYLE = {
  running: {
    Icon: LoaderCircle,
    className: 'text-warning motion-safe:animate-pulse',
    word: 'running',
  },
  done: { Icon: CircleCheck, className: 'text-success', word: 'done' },
  error: { Icon: CircleAlert, className: 'text-danger', word: 'failed' },
} as const

// Every node of nodes, depth first, in the order they are drawn.
export function flattenSubagents(nodes: readonly SubagentNode[]) {
  const out: SubagentNode[] = []
  const walk = (list: readonly SubagentNode[]) => {
    for (const n of list) {
      out.push(n)
      walk(n.children)
    }
  }
  walk(nodes)
  return out
}

// "3 subagents, 1 running", or undefined when there are none.
export function subagentSummary(tree?: Subagents): string | undefined {
  const all = flattenSubagents(tree?.nodes ?? [])
  if (!all.length) return undefined
  const running = all.filter((n) => n.status === 'running').length
  const noun = all.length === 1 ? 'subagent' : 'subagents'
  return running
    ? `${all.length} ${noun}, ${running} running`
    : `${all.length} ${noun}`
}

// How long a subagent ran, or has been running: "42 s", "3 min", "2 h".
export function subagentDuration(
  n: SubagentNode,
  now: number,
): string | undefined {
  const start = n.startTs ? Date.parse(n.startTs) : Number.NaN
  const end = n.endTs ? Date.parse(n.endTs) : n.status === 'running' ? now : NaN
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  const s = Math.max(0, Math.round((end - start) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  return `${Math.floor(s / 3600)} h`
}

interface Props {
  tree?: Subagents
  error: boolean
  // Server time (ms)
  now: number
}

// The subagents of a Claude session, indented by depth.
export function SubagentTree({ tree, error, now }: Props) {
  if (!tree) {
    return error ? (
      <p className="text-[12px] text-fg-muted">Could not read subagents.</p>
    ) : (
      <span
        aria-hidden="true"
        className="block h-4 w-1/2 rounded-control bg-surface-raised motion-safe:animate-pulse"
      />
    )
  }
  const all = flattenSubagents(tree.nodes)
  if (!all.length) {
    return <p className="text-[12px] text-fg-muted">No subagents.</p>
  }
  const shown = all.slice(0, SUBAGENT_TREE_MAX)
  const more = all.length - shown.length
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label="Subagents" className="flex flex-col gap-1">
        {shown.map((n) => {
          const { Icon, className, word } = NODE_STYLE[n.status]
          const took = subagentDuration(n, now)
          return (
            <li
              key={n.id}
              data-status={n.status}
              className="flex min-w-0 items-start gap-1.5 border-l border-border pl-2 text-[12px]"
              style={{ marginLeft: `${(n.depth - 1) * 12}px` }}
            >
              <Icon
                size={13}
                aria-hidden="true"
                className={`mt-0.5 shrink-0 ${className}`}
              />
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-semibold text-fg">
                    {n.type}
                  </span>
                  <span className="shrink-0 text-fg-muted">
                    · {word}
                    {n.statusGuessed && ' (guessed)'}
                    {took && ` · ${took}`}
                  </span>
                </span>
                {n.description && (
                  <span className="truncate text-fg-muted">
                    {n.description}
                  </span>
                )}
                {n.lastTool && (
                  <span className="truncate font-mono text-[11px] text-fg-subtle">
                    {n.lastTool}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {(more > 0 || tree.truncated) && (
        <p className="text-[12px] text-fg-subtle">
          {more > 0
            ? `and ${more} more`
            : 'Older or deeper subagents not shown'}
        </p>
      )}
    </div>
  )
}
