import { Plus, X } from 'lucide-react'
import {
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { ENTER_FROM, useNewKeys } from '../hooks/use-new-keys'
import { LEAVE_TO, usePresenceList } from '../hooks/use-presence-list'
import { useWheelScrollX } from '../hooks/use-wheel-scroll-x'
import { useT } from '../i18n/i18n-context'
import type { Session } from '../types/session'
import { dropIndex } from '../utils/reorder'
import { visibleUnsafe } from '../utils/unsafe-chars'
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
  // Moving a tab within these (caps.reorderTabs); unset, tabs do not drag.
  // index: the final position, in the server's order
  onMove?: (id: string, index: number) => void
}

// Where a dragged tab would land: before or after the tab under the pointer
interface DropTarget {
  id: string
  after: boolean
}

// Browser-style tabs in the desktop header row. A tab is a role="tab"
// button; its close button is a sibling, never nested in it, and Add sits
// outside the tablist. Arrow keys move focus between tabs; Enter or Space
// switches, since every switch is a request to the backend; Delete closes the
// focused tab, so the close buttons stay out of the tab order. With onMove,
// a tab drags before or after another; a 2 px line shows where it lands.
// A new tab fades in; a closed one fades out, inert and out of the tab order
// and of dragging, then the others close up.
export function SessionTabs({
  sessions,
  activeId,
  onSelect,
  onAdd,
  onRemove,
  canRemove = sessions.length > 1,
  onMove,
}: Props) {
  const { t } = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScrollX(scrollRef)
  const activeRef = useRef<HTMLButtonElement>(null)
  // The tab being dragged, kept here: while dragging over a tab the browser
  // shows only the data's types, never the data.
  const dragged = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const { entries, ref } = usePresenceList(sessions, sessionId)
  const isNew = useNewKeys(sessions.map(sessionId))

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
    // A closed tab still fading out is not one of them
    const tabs = [
      ...scrollRef.current!.querySelectorAll<HTMLElement>('[role="tab"]'),
    ].filter((tab) => !tab.closest('[data-leaving]'))
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

  // Drag and drop (desktop): the half of the tab under the pointer says
  // before or after it.
  const movable = !!onMove && sessions.length > 1
  const ids = sessions.map((s) => s.id)
  const dragProps = (id: string) => {
    if (!movable) return {}
    const isAfter = (e: DragEvent<HTMLElement>) => {
      const box = e.currentTarget.getBoundingClientRect()
      return e.clientX > box.left + box.width / 2
    }
    const end = () => {
      dragged.current = null
      setDropTarget(null)
    }
    return {
      draggable: true,
      onDragStart: (e: DragEvent) => {
        dragged.current = id
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/x-termote-tab', id)
      },
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!dragged.current) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const after = isAfter(e)
        if (dropTarget?.id !== id || dropTarget.after !== after) {
          setDropTarget({ id, after })
        }
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        const from = dragged.current
        if (!from) return
        e.preventDefault()
        const index = dropIndex(ids, from, id, isAfter(e))
        if (index !== null) onMove(from, index)
        end()
      },
      onDragEnd: end,
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-end gap-1 self-stretch">
      <div
        ref={scrollRef}
        data-tour="session-tabs"
        role="tablist"
        aria-label={t('shell.tabs.label')}
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-end gap-1 overflow-x-auto scrollbar-hide"
      >
        {entries.map(({ item: session, key, leaving }) => {
          const active = !leaving && session.id === activeId
          return (
            <div
              key={key}
              ref={ref(key)}
              inert={leaving}
              data-leaving={leaving || undefined}
              {...(leaving ? {} : dragProps(session.id))}
              className={`group relative flex h-9 shrink-0 items-center pr-1.5 text-[13px] transition-[color,background-color,border-color,opacity,translate,scale] duration-(--duration-fast) ease-standard motion-safe:active:scale-[0.98] ${isNew(key) ? ENTER_FROM : ''} ${leaving ? LEAVE_TO : ''} ${
                active
                  ? 'pointer-coarse:h-11 rounded-t-control border border-b-0 border-border bg-term text-fg shadow-sm ui-terminal:shadow-[inset_0_2px_0_var(--color-accent)] ui-native:rounded-t-panel ui-native:border-0'
                  : 'mb-1 h-8 pointer-coarse:h-10 rounded-control text-fg-muted hover:bg-surface-raised hover:text-fg'
              }`}
            >
              {/* Inside the tab's edge: the scrolling tablist cuts off
                  anything past its first and last tab */}
              {dropTarget?.id === session.id && (
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute inset-y-1 z-10 w-0.5 rounded-full bg-accent ${
                    dropTarget.after ? 'right-0' : 'left-0'
                  }`}
                />
              )}
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
                    ? `${visibleUnsafe(session.name)} - ${session.description}`
                    : visibleUnsafe(session.name)
                }
                className={`flex h-full items-center gap-2 whitespace-nowrap rounded-control pl-3 pr-1 ${FOCUS_RING} focus-visible:-outline-offset-2`}
              >
                <span className="text-base leading-none">{session.icon}</span>
                <span className="max-w-[140px] truncate ui-terminal:font-label">
                  {visibleUnsafe(session.name)}
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
                  aria-label={t('shell.tabs.close', { name: session.name })}
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
          aria-label={t('shell.tabs.add')}
          title={t('shell.tabs.add')}
        >
          <Plus size={16} aria-hidden="true" />
        </IconButton>
      )}
    </div>
  )
}

const sessionId = (s: Session) => s.id
