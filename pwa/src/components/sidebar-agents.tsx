import { ChevronDown, ChevronRight } from 'lucide-react'
import {
  type KeyboardEvent,
  type PointerEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNow } from '../hooks/use-now'
import { useSidebarAgentsCollapsed } from '../hooks/use-sidebar-agents-collapsed'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type {
  AgentStatus,
  Session,
  SessionGroup,
  SessionPane,
} from '../types/session'
import {
  agentCards,
  groupByStatus,
  type OverviewCard,
} from '../utils/agent-cards'
import { overviewOrder } from '../utils/overview-order'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { statusAge } from './agent-card'
import { AgentStatusBadge } from './agent-status-badge'
import {
  ACTIVE_ROW_CLASSES,
  ROW_CLASSES,
  ROW_PRESS,
} from './sidebar-row-classes'
import { FOCUS_RING } from './ui/button'

// The section's height, in px: what it starts at, the least it takes, and a
// key step. At most AGENTS_HEIGHT_SHARE of the sidebar, so the workspaces
// above always keep some room.
export const AGENTS_HEIGHT_DEFAULT = 240
export const AGENTS_HEIGHT_MIN = 96
export const AGENTS_HEIGHT_STEP = 16
const AGENTS_HEIGHT_SHARE = 0.7
const HEIGHT_KEY = 'sidebar-agents-height'

// A saved height, or the default for none or one this version cannot use
function loadHeight(): number {
  try {
    const saved = Number(localStorage.getItem(HEIGHT_KEY))
    return Number.isFinite(saved) && saved >= AGENTS_HEIGHT_MIN
      ? saved
      : AGENTS_HEIGHT_DEFAULT
  } catch {
    return AGENTS_HEIGHT_DEFAULT
  }
}

function saveHeight(height: number) {
  try {
    localStorage.setItem(HEIGHT_KEY, String(height))
  } catch {
    // kept for this page only
  }
}

// The most the section may take of a sidebar room px high; no limit until
// measured (no ResizeObserver: tests)
const maxHeight = (room: number | null) =>
  room === null
    ? Number.POSITIVE_INFINITY
    : Math.max(AGENTS_HEIGHT_MIN, Math.floor(room * AGENTS_HEIGHT_SHARE))

const clampHeight = (height: number, max: number) =>
  Math.min(Math.max(height, AGENTS_HEIGHT_MIN), max)

const STATUS_TITLE: Record<AgentStatus, MessageKey> = {
  blocked: 'tasks.status.blocked',
  working: 'tasks.status.working',
  done: 'tasks.status.done',
  idle: 'tasks.status.idle',
}

interface Props {
  // Every tab: the section lists every agent, whatever the list above shows
  sessions: Session[]
  groups: SessionGroup[]
  // The pane on screen, its row marked
  activePaneId?: string
  // Server time minus this device's (ms)
  clockOffset: number
  onOpen: (session: Session, pane: SessionPane) => void
}

// The compact sidebar's Agents: every pane running an agent, in every
// workspace, by status (those waiting on the user first), each with where
// it runs and how long it has been so. A row opens its pane, as an overview
// card does. Nothing at all while no agent runs.
export function SidebarAgents({ sessions, ...rest }: Props) {
  const cards = useMemo(() => overviewOrder(agentCards(sessions)), [sessions])
  if (cards.length === 0) return null
  return <AgentsSection cards={cards} {...rest} />
}

function AgentsSection({
  cards,
  groups,
  activePaneId,
  clockOffset,
  onOpen,
}: Omit<Props, 'sessions'> & { cards: OverviewCard[] }) {
  const { t } = useT()
  const now = useNow(clockOffset)
  const { isCollapsed, toggle } = useSidebarAgentsCollapsed()
  const byStatus = useMemo(() => groupByStatus(cards), [cards])
  const groupOf = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  // One group (tmux): its name says nothing
  const showGroups = groups.length > 1

  // The sidebar's height: the section takes at most a share of it
  const sectionRef = useRef<HTMLElement>(null)
  const [room, setRoom] = useState<number | null>(null)
  useLayoutEffect(() => {
    const column = sectionRef.current!.parentElement!
    if (typeof ResizeObserver === 'undefined') return
    setRoom(column.clientHeight)
    const ro = new ResizeObserver(() => setRoom(column.clientHeight))
    ro.observe(column)
    return () => ro.disconnect()
  }, [])

  // While dragging, only this follows the pointer; it is saved on release.
  const [height, setHeight] = useState(loadHeight)
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const drag = useRef<{ y: number; height: number; last: number } | null>(null)
  const max = maxHeight(room)
  const shown = clampHeight(dragHeight ?? height, max)
  const commit = (next: number) => {
    setHeight(next)
    saveHeight(next)
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // No text selection while dragging
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { y: e.clientY, height: shown, last: shown }
    setDragHeight(shown)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    // The handle is on the top edge: moving up makes the section taller.
    d.last = clampHeight(d.height + d.y - e.clientY, max)
    setDragHeight(d.last)
  }
  const endDrag = () => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (d.last !== d.height) commit(d.last)
    setDragHeight(null)
  }
  // Up and Down step, Home and End go to the limits
  const onHandleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number
    if (e.key === 'ArrowUp') next = shown + AGENTS_HEIGHT_STEP
    else if (e.key === 'ArrowDown') next = shown - AGENTS_HEIGHT_STEP
    else if (e.key === 'Home') next = AGENTS_HEIGHT_MIN
    else if (e.key === 'End' && Number.isFinite(max)) next = max
    else return
    e.preventDefault()
    const clamped = clampHeight(next, max)
    if (clamped !== shown) commit(clamped)
  }

  const renderRow = ({ session, pane, status }: OverviewCard) => {
    const group = session.groupId ? groupOf.get(session.groupId) : undefined
    const place = showGroups && group ? group.name || group.id : undefined
    const age = statusAge(pane.agentSince, pane.agentSinceFirstSeen, now, t)
    const active = pane.id === activePaneId
    return (
      <li key={pane.id}>
        <button
          type="button"
          aria-current={active ? 'true' : undefined}
          onClick={() => onOpen(session, pane)}
          title={visibleUnsafe(
            [place, session.name, pane.label].filter(Boolean).join(' · '),
          )}
          className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-control px-2 text-left text-[13px] ${ROW_PRESS} ${
            active ? ACTIVE_ROW_CLASSES : ROW_CLASSES
          } ${FOCUS_RING} focus-visible:-outline-offset-2`}
        >
          <AgentStatusBadge status={status} size={12} />
          <span className="min-w-0 flex-1 truncate ui-terminal:font-label ui-terminal:text-[12px]">
            {place && (
              <>
                <span className="font-medium text-fg">
                  {visibleUnsafe(place)}
                </span>
                <span className="text-fg-subtle"> · </span>
              </>
            )}
            <span className={place ? 'text-fg-muted' : 'text-fg'}>
              {visibleUnsafe(session.name)}
            </span>
          </span>
          {age && (
            <span className="shrink-0 text-[11px] tabular-nums text-fg-subtle">
              {age}
            </span>
          )}
        </button>
      </li>
    )
  }

  return (
    <>
      {!isCollapsed && (
        // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focused or dragged
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('shell.sidebar.agentsResize')}
          aria-valuenow={shown}
          aria-valuemin={AGENTS_HEIGHT_MIN}
          aria-valuemax={Number.isFinite(max) ? max : undefined}
          tabIndex={0}
          title={t('shell.panel.resizeHint')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={() => commit(AGENTS_HEIGHT_DEFAULT)}
          onKeyDown={onHandleKeyDown}
          className={`relative z-10 -mb-1 h-2 shrink-0 cursor-row-resize touch-none outline-none hover:bg-accent/40 focus-visible:bg-accent ${
            dragHeight !== null ? 'bg-accent/40' : ''
          }`}
        />
      )}
      <section
        ref={sectionRef}
        aria-label={t('shell.sidebar.agents')}
        style={isCollapsed ? undefined : { height: shown }}
        className="flex shrink-0 flex-col border-t border-border"
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!isCollapsed}
          title={t('shell.sidebar.agentsToggle')}
          className={`flex h-9 shrink-0 items-center gap-1.5 px-3 font-label text-[11px] font-semibold uppercase tracking-wider text-fg ${FOCUS_RING} focus-visible:-outline-offset-2`}
        >
          {isCollapsed ? (
            <ChevronRight size={12} aria-hidden="true" />
          ) : (
            <ChevronDown size={12} aria-hidden="true" />
          )}
          {t('shell.sidebar.agents')}
          <span className="ml-auto font-normal tabular-nums text-fg-muted">
            {cards.length}
          </span>
        </button>
        {!isCollapsed && (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 scrollbar-hover">
            {byStatus.map(([status, list]) => (
              <section
                key={status}
                aria-label={t(STATUS_TITLE[status])}
                className="pt-1"
              >
                <h3 className="m-0 flex items-center gap-1.5 px-2 pb-0.5 text-[11px] font-medium text-fg-subtle">
                  {t(STATUS_TITLE[status])}
                  <span className="tabular-nums">{list.length}</span>
                </h3>
                <ul className="m-0 flex list-none flex-col gap-px p-0">
                  {list.map(renderRow)}
                </ul>
              </section>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
