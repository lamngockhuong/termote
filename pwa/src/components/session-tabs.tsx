import { Plus, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef } from 'react'
import type { Session } from '../types/session'
import { AgentStatusBadge } from './agent-status-badge'
import { FOCUS_RING, IconButton } from './ui/button'

interface Props {
  sessions: Session[]
  activeId: string
  onSelect: (id: string) => void
  // Unset (view-only role): no Add button.
  onAdd?: () => void
  onRemove: (id: string) => void
  // Whether a tab may be closed; defaults to "more than one tab here".
  canRemove?: boolean
}

// Browser-style tabs in the desktop header row. A tab is a role="tab"
// button; its close button is a sibling, never nested in it, and Add sits
// outside the tablist. Arrow keys move focus between tabs; Enter or Space
// switches, since every switch is a request to the backend; Delete closes the
// focused tab, so the close buttons stay out of the tab order.
export function SessionTabs({
  sessions,
  activeId,
  onSelect,
  onAdd,
  onRemove,
  canRemove = sessions.length > 1,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLButtonElement>(null)

  // Scroll active tab into view only if not visible
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId triggers scroll when tab changes
  useEffect(() => {
    const el = activeRef.current
    const container = scrollRef.current
    /* v8 ignore next */
    if (!el || !container) return

    const rect = el.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    const isVisible =
      rect.left >= containerRect.left && rect.right <= containerRect.right

    if (!isVisible) {
      el.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'center',
      })
    }
  }, [activeId])

  const onKeyDown = (e: KeyboardEvent) => {
    const tabs = [
      ...scrollRef.current!.querySelectorAll<HTMLElement>('[role="tab"]'),
    ]
    const at = tabs.indexOf(document.activeElement as HTMLElement)
    if (at === -1) return
    if (e.key === 'Delete') {
      if (!canRemove) return
      e.preventDefault()
      onRemove(sessions[at].id)
      return
    }
    const last = tabs.length - 1
    const next = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    }[e.key]
    if (next === undefined) return
    e.preventDefault()
    tabs[next].focus()
  }

  return (
    <div className="flex min-w-0 flex-1 items-end gap-1 self-stretch">
      <div
        ref={scrollRef}
        role="tablist"
        aria-label="Sessions"
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-end gap-1 overflow-x-auto scrollbar-hide"
      >
        {sessions.map((session) => {
          const active = session.id === activeId
          return (
            <div
              key={session.id}
              className={`group flex h-9 shrink-0 items-center pr-1.5 text-[13px] transition-colors duration-(--duration-fast) ${
                active
                  ? 'pointer-coarse:h-11 rounded-t-control border border-b-0 border-border bg-term text-fg shadow-sm ui-terminal:shadow-[inset_0_2px_0_var(--color-accent)] ui-native:rounded-t-panel ui-native:border-0'
                  : 'mb-1 h-8 pointer-coarse:h-10 rounded-control text-fg-muted hover:bg-surface-raised hover:text-fg'
              }`}
            >
              <button
                ref={active ? activeRef : null}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(session.id)}
                aria-keyshortcuts={canRemove ? 'Delete' : undefined}
                title={
                  session.description
                    ? `${session.name} - ${session.description}`
                    : session.name
                }
                className={`flex h-full items-center gap-2 whitespace-nowrap rounded-control pl-3 pr-1 ${FOCUS_RING} focus-visible:-outline-offset-2`}
              >
                <span className="text-base leading-none">{session.icon}</span>
                <span className="max-w-[140px] truncate ui-terminal:font-label">
                  {session.name}
                </span>
                <AgentStatusBadge status={session.agentStatus} size={12} />
              </button>
              {canRemove && (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => onRemove(session.id)}
                  className={`flex size-5 items-center justify-center rounded-[calc(var(--radius-control)-2px)] text-fg-subtle hover:bg-surface hover:text-fg ${
                    active ? '' : 'invisible group-hover:visible'
                  }`}
                  aria-label={`Close ${session.name}`}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {onAdd && (
        <IconButton
          size="sm"
          onClick={onAdd}
          className="mb-1"
          aria-label="Add session"
          title="Add session"
        >
          <Plus size={16} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  )
}
