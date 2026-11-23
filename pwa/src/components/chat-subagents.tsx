import { Bot, ChevronDown } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import type { SubagentNode } from '../hooks/use-mux-api'
import { useSubagents } from '../hooks/use-subagents'
import { useT } from '../i18n/i18n-context'
import { flattenSubagents, SubagentTree } from './subagent-tree'

// The subagents still running, under the conversation of a Claude session:
// they run in the background, so the conversation itself does not say when
// one ends. Nothing is drawn while none runs.

// The running nodes of a tree, with the ones above a running one kept for
// its place in it
export function runningSubagents(
  nodes: readonly SubagentNode[],
): SubagentNode[] {
  return nodes.flatMap((n) => {
    const children = runningSubagents(n.children)
    return n.status === 'running' || children.length ? [{ ...n, children }] : []
  })
}

// The server's time (ms), a new one each second while ticking
export function useServerSeconds(ticking: boolean, clockOffset: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [ticking])
  return now + clockOffset
}

export function ChatSubagents({
  paneId,
  clockOffset = 0,
  onOpen,
}: {
  paneId: string
  // The server's clock minus this device's (ms)
  clockOffset?: number
  // Opens a subagent's conversation (each row a button)
  onOpen?: (node: SubagentNode) => void
}) {
  const { t } = useT()
  const listId = useId()
  const [open, setOpen] = useState(true)
  const { tree } = useSubagents(paneId, true)
  const running = useMemo(() => runningSubagents(tree?.nodes ?? []), [tree])
  const count = flattenSubagents(running).filter(
    (n) => n.status === 'running',
  ).length
  const now = useServerSeconds(count > 0 && open, clockOffset)
  if (!count) return null
  const label = t('chat.subagent.runningCount', { count })
  return (
    <div className="shrink-0 border-t border-border px-3 py-1.5">
      {/* The count is read out as it changes; a live region inside the
          button would leave the button without a name */}
      <span role="status" className="sr-only">
        {label}
      </span>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-2 rounded-sm text-left text-[12px] text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
      >
        <Bot
          size={13}
          aria-hidden="true"
          className="shrink-0 text-warning motion-safe:animate-pulse"
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`shrink-0 transition-transform duration-(--duration-base) ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div id={listId} className="mt-1.5 max-h-[30vh] overflow-y-auto">
          <SubagentTree
            tree={{ nodes: running }}
            error={false}
            now={now}
            onOpen={onOpen}
          />
        </div>
      )}
    </div>
  )
}
