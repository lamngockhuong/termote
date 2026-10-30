import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react'
import type { SubagentNode, Subagents } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Skeleton } from './ui/skeleton'

// At most this many subagents are drawn; the rest are counted.
export const SUBAGENT_TREE_MAX = 20

// Each status has its own icon; a running one glows slowly (opacity only),
// still when the user asks for reduced motion.
const NODE_STYLE = {
  running: {
    Icon: LoaderCircle,
    className: 'text-warning motion-safe:animate-pulse',
    word: 'chat.subagent.running',
  },
  done: {
    Icon: CircleCheck,
    className: 'text-success',
    word: 'chat.subagent.done',
  },
  error: {
    Icon: CircleAlert,
    className: 'text-danger',
    word: 'chat.subagent.failed',
  },
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
export function subagentSummary(
  tree: Subagents | undefined,
  t: Translate<MessageKey>,
): string | undefined {
  const all = flattenSubagents(tree?.nodes ?? [])
  if (!all.length) return undefined
  const running = all.filter((n) => n.status === 'running').length
  return running
    ? t('chat.subagent.countRunning', { count: all.length, running })
    : t('chat.subagent.count', { count: all.length })
}

// How long a subagent ran, or has been running: "42 s", "3 min", "2 h".
export function subagentDuration(
  n: SubagentNode,
  now: number,
  t: Translate<MessageKey>,
): string | undefined {
  const start = n.startTs ? Date.parse(n.startTs) : Number.NaN
  const end = n.endTs ? Date.parse(n.endTs) : n.status === 'running' ? now : NaN
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  const s = Math.max(0, Math.round((end - start) / 1000))
  if (s < 60) return t('chat.subagent.seconds', { n: s })
  if (s < 3600) return t('chat.subagent.minutes', { n: Math.floor(s / 60) })
  return t('chat.subagent.hours', { n: Math.floor(s / 3600) })
}

interface Props {
  tree?: Subagents
  error: boolean
  // Server time (ms)
  now: number
}

// The subagents of a Claude session, indented by depth.
export function SubagentTree({ tree, error, now }: Props) {
  const { t } = useT()
  if (!tree) {
    return error ? (
      <p className="text-[12px] text-fg-muted">
        {t('chat.subagent.readFailed')}
      </p>
    ) : (
      <Skeleton className="h-4 w-1/2" />
    )
  }
  const all = flattenSubagents(tree.nodes)
  if (!all.length) {
    return (
      <p className="text-[12px] text-fg-muted">{t('chat.subagent.none')}</p>
    )
  }
  const shown = all.slice(0, SUBAGENT_TREE_MAX)
  const more = all.length - shown.length
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label={t('chat.subagent.list')} className="flex flex-col gap-1">
        {shown.map((n) => {
          const { Icon, className, word } = NODE_STYLE[n.status]
          const took = subagentDuration(n, now, t)
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
                    {visibleUnsafe(n.type)}
                  </span>
                  <span className="shrink-0 text-fg-muted">
                    · {t(word)}
                    {n.statusGuessed && ` ${t('chat.subagent.guessed')}`}
                    {took && ` · ${took}`}
                  </span>
                </span>
                {n.description && (
                  <span className="truncate text-fg-muted">
                    {visibleUnsafe(n.description)}
                  </span>
                )}
                {n.lastTool && (
                  <span className="truncate font-mono text-[11px] text-fg-subtle">
                    {visibleUnsafe(n.lastTool)}
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
            ? t('chat.subagent.more', { count: more })
            : t('chat.subagent.truncated')}
        </p>
      )}
    </div>
  )
}
