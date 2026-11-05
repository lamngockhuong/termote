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
import { dropIndex, targetIndex } from '../utils/reorder'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { AgentStatusBadge } from './agent-status-badge'
import { IconSheet } from './icon-picker'
import { onlyPaneOf } from './meta-chips'
import { NewTabForm } from './new-tab-form'
import { FOCUS_RING, IconButton } from './ui/button'
import { Menu, MenuItem, MenuSeparator } from './ui/menu'

interface Props {
  sessions: Session[]
  activeId: string
  onSelect: (id: string) => void
  // Unset (view-only role): no Add button. A name and icon come from the
  // form; without them the backend's default name is used.
  onAdd?: (name?: string, icon?: string) => void
  // The Add button asks for a name and icon first (the compact sidebar,
  // whose own form is not on screen); else it adds a tab at once
  askName?: boolean
  onRemove: (id: string) => void
  // Whether a tab may be closed; defaults to "more than one tab here".
  canRemove?: boolean
  // Moving a tab within these (caps.reorderTabs); unset, tabs do not drag.
  // index: the final position, in the server's order
  onMove?: (id: string, index: number) => void
  // A move is on its way to the server: the tab is not in its new place yet
  moving?: boolean
  // Unset (view-only role): no rename and no icon in the tab's menu
  onUpdate?: (id: string, updates: { name?: string; icon?: string }) => void
  // The backend can rename this tab (caps.renameTab); false: only its icon
  renameTab?: boolean
}

// Shift+F10 or the context menu key: the menu of the focused tab
const menuKey = (e: KeyboardEvent) =>
  e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)

// What a tab's hover shows: its name and description, a one-pane tab's
// pane name and metadata, and what runs in it
function tabTitle(session: Session): string {
  const name = visibleUnsafe(session.name)
  const pane = onlyPaneOf(session)
  return [
    session.description ? `${name} - ${session.description}` : name,
    pane &&
      [
        pane.name && visibleUnsafe(pane.name),
        ...(pane.meta ?? []).map(
          (m) => `${visibleUnsafe(m.key)}: ${visibleUnsafe(m.value)}`,
        ),
      ]
        .filter(Boolean)
        .join(' · '),
    session.commands && visibleUnsafe(session.commands.join(', ')),
  ]
    .filter(Boolean)
    .join('\n')
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
// A right click, Shift+F10 or the menu key opens a tab's menu: rename (F2,
// in place), icon, move (Alt+Left/Right), a new tab with a name, close.
export function SessionTabs({
  sessions,
  activeId,
  onSelect,
  onAdd,
  askName = false,
  onRemove,
  canRemove = sessions.length > 1,
  onMove,
  moving = false,
  onUpdate,
  renameTab = true,
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
  // By a tab's lasting key: a tmux tab's id is its window number, which a
  // move renumbers
  const tabButtons = useRef(new Map<string, HTMLButtonElement>())
  // The tab the menu was asked on, which it hangs from
  const menuAnchor = useRef<HTMLElement | null>(null)
  const [menu, setMenu] = useState<{ id: string; byKey: boolean } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [iconFor, setIconFor] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  // A tab moved by its keys, or renamed, takes the focus back once it is
  // drawn in its place: moving the focused node in the DOM drops its focus
  const refocus = useRef<string | null>(null)
  useEffect(() => {
    const key = refocus.current
    if (!key || renaming || moving) return
    refocus.current = null
    tabButtons.current.get(key)?.focus()
  })

  const canRename = !!onUpdate && renameTab
  const ids = sessions.map((s) => s.id)
  const hasMenu = !!onUpdate || !!onAdd || !!onMove || canRemove
  const openMenu = (id: string, byKey: boolean) => {
    // Asked from the tab's own button, which is there
    menuAnchor.current = tabButtons.current.get(
      lastingKey(sessions.find((s) => s.id === id)!),
    )!
    setMenu({ id, byKey })
  }
  const startRename = (session: Session) => {
    setDraft(session.name)
    setRenaming(session.id)
  }
  const endRename = (save: boolean) => {
    // The field is drawn only for a tab still here (a leaving one is inert)
    const session = sessions.find((s) => s.id === renaming)!
    const name = draft.trim()
    if (save && name && name !== session.name) onUpdate!(session.id, { name })
    refocus.current = lastingKey(session)
    setRenaming(null)
  }
  const step = (id: string, delta: -1 | 1) => {
    const index = targetIndex(ids, id, delta)
    if (index === null) return
    refocus.current = lastingKey(sessions[ids.indexOf(id)])
    onMove!(id, index)
  }
  const addRef = useRef<HTMLButtonElement>(null)
  // The form opened from a tab's menu gives the focus back to that tab,
  // from + to +
  const formFrom = useRef<HTMLElement | null>(null)
  const openForm = (from: HTMLElement | null) => {
    formFrom.current = from
    setFormOpen(true)
  }
  const closeForm = () => {
    setFormOpen(false)
    formFrom.current?.focus()
  }
  const addTab = () =>
    askName ? (formOpen ? closeForm() : openForm(addRef.current)) : onAdd!()

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
    const id = sessions[at].id
    if (menuKey(e)) {
      if (!hasMenu) return
      e.preventDefault()
      openMenu(id, true)
      return
    }
    if (e.key === 'F2') {
      if (!canRename) return
      e.preventDefault()
      startRename(sessions[at])
      return
    }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      // Alt+Left would also go back a page, where tabs cannot move too
      e.preventDefault()
      if (onMove) step(id, e.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    if (e.key === 'Delete') {
      if (!canRemove) return
      e.preventDefault()
      onRemove(id)
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

  const menuAt = menu ? ids.indexOf(menu.id) : -1
  // A tab closed while its menu is open takes the menu with it
  const menuSession = menuAt === -1 ? undefined : sessions[menuAt]
  const iconSession = sessions.find((s) => s.id === iconFor)

  // Drag and drop (desktop): the half of the tab under the pointer says
  // before or after it.
  const movable = !!onMove && sessions.length > 1
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
    <div className="relative flex min-w-0 flex-1 items-end gap-1 self-stretch">
      <div
        ref={scrollRef}
        data-tour="session-tabs"
        role="tablist"
        aria-label={t('shell.tabs.label')}
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-end gap-1 overflow-x-auto scrollbar-hide"
      >
        {entries.map(({ item: session, key, leaving }) => {
          // A closing active tab keeps its look while it fades (no jump),
          // but is no longer the selected one
          const looksActive = session.id === activeId
          const active = !leaving && looksActive
          const keys = [
            hasMenu && 'Shift+F10',
            canRename && 'F2',
            onMove && 'Alt+ArrowLeft Alt+ArrowRight',
            canRemove && 'Delete',
          ].filter(Boolean)
          return (
            <div
              key={key}
              ref={ref(key)}
              inert={leaving}
              aria-hidden={leaving || undefined}
              data-leaving={leaving || undefined}
              {...(leaving || renaming === session.id
                ? {}
                : dragProps(session.id))}
              onContextMenu={(e) => {
                if (leaving || !hasMenu || renaming === session.id) return
                e.preventDefault()
                openMenu(session.id, false)
              }}
              className={`group relative flex h-9 shrink-0 items-center pr-1.5 text-[13px] transition-[color,background-color,border-color,opacity,translate,scale] duration-(--duration-fast) ease-standard motion-safe:active:scale-[0.98] ${isNew(key) ? ENTER_FROM : ''} ${leaving ? LEAVE_TO : ''} ${
                looksActive
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
              {renaming === session.id ? (
                <span className="flex h-full items-center gap-2 pl-3 pr-1">
                  <span className="text-base leading-none">{session.icon}</span>
                  <input
                    type="text"
                    aria-label={t('shell.tabs.renameField', {
                      name: session.name,
                    })}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter or Escape that ends an IME composition
                      if (e.nativeEvent.isComposing) return
                      if (e.key !== 'Enter' && e.key !== 'Escape') return
                      e.preventDefault()
                      endRename(e.key === 'Enter')
                    }}
                    onBlur={() => setRenaming(null)}
                    autoFocus
                    className="h-6 w-[140px] min-w-0 rounded-[calc(var(--radius-control)-2px)] border border-accent bg-bg px-1.5 text-[13px] text-fg outline-none"
                  />
                </span>
              ) : (
                <button
                  ref={(el) => {
                    if (active) activeRef.current = el
                    if (el) tabButtons.current.set(lastingKey(session), el)
                    else tabButtons.current.delete(lastingKey(session))
                  }}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  onClick={() => onSelect(session.id)}
                  aria-keyshortcuts={keys.join(' ') || undefined}
                  title={tabTitle(session)}
                  className={`flex h-full items-center gap-2 whitespace-nowrap rounded-control pl-3 pr-1 ${FOCUS_RING} focus-visible:-outline-offset-2`}
                >
                  <span className="text-base leading-none">{session.icon}</span>
                  <span className="max-w-[140px] truncate ui-terminal:font-label">
                    {visibleUnsafe(session.name)}
                  </span>
                  <AgentStatusBadge status={session.agentStatus} size={12} />
                </button>
              )}
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
          ref={addRef}
          size="sm"
          // Not a press outside the form: + itself closes it
          data-new-tab-toggle
          onClick={addTab}
          aria-expanded={askName ? formOpen : undefined}
          className="mb-1"
          aria-label={t('shell.tabs.add')}
          title={t('shell.tabs.add')}
        >
          <Plus size={16} aria-hidden="true" />
        </IconButton>
      )}
      {formOpen && (
        <NewTabForm
          onAdd={(name, icon) => onAdd!(name, icon)}
          onClose={closeForm}
        />
      )}
      {menuSession && (
        <Menu
          label={t('shell.tabs.menu', { name: menuSession.name })}
          trigger={null}
          anchorRef={menuAnchor}
          focusFirst={menu!.byKey}
          align="start"
          open
          onOpenChange={(open) => !open && setMenu(null)}
        >
          {onUpdate && (
            <>
              <MenuItem
                disabled={!renameTab}
                title={renameTab ? undefined : t('shell.sidebar.tabNameFixed')}
                // i18n-ignore: a key's name
                shortcut={{ label: 'F2', aria: 'F2' }}
                onSelect={() => startRename(menuSession)}
              >
                {t('shell.tabs.rename')}
              </MenuItem>
              <MenuItem onSelect={() => setIconFor(menuSession.id)}>
                {t('shell.tabs.editIcon')}
              </MenuItem>
            </>
          )}
          {onMove && (
            <>
              <MenuItem
                disabled={menuAt === 0}
                // i18n-ignore: a key's name
                shortcut={{ label: 'Alt+←', aria: 'Alt+ArrowLeft' }}
                onSelect={() => step(menuSession.id, -1)}
              >
                {t('shell.tabs.moveLeft')}
              </MenuItem>
              <MenuItem
                disabled={menuAt === sessions.length - 1}
                // i18n-ignore: a key's name
                shortcut={{ label: 'Alt+→', aria: 'Alt+ArrowRight' }}
                onSelect={() => step(menuSession.id, 1)}
              >
                {t('shell.tabs.moveRight')}
              </MenuItem>
            </>
          )}
          {onAdd && (
            <MenuItem onSelect={() => openForm(menuAnchor.current)}>
              {t('shell.tabs.new')}
            </MenuItem>
          )}
          {canRemove && (
            <>
              <MenuSeparator />
              <MenuItem
                danger
                // i18n-ignore: a key's name
                shortcut={{ label: 'Del', aria: 'Delete' }}
                onSelect={() => onRemove(menuSession.id)}
              >
                {t('shell.tabs.closeItem')}
              </MenuItem>
            </>
          )}
        </Menu>
      )}
      {onUpdate && (
        <IconSheet
          isOpen={!!iconSession}
          value={iconSession?.icon ?? ''}
          onClose={() => setIconFor(null)}
          onSelect={(icon) => {
            onUpdate(iconSession!.id, { icon })
            setIconFor(null)
          }}
        />
      )}
    </div>
  )
}

const sessionId = (s: Session) => s.id
const lastingKey = (s: Session) => s.key ?? s.id
