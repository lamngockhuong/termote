import { Plus, X } from 'lucide-react'
import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { ENTER_FROM, useNewKeys } from '../hooks/use-new-keys'
import { LEAVE_TO, usePresenceList } from '../hooks/use-presence-list'
import { useWheelScrollX } from '../hooks/use-wheel-scroll-x'
import { useT } from '../i18n/i18n-context'
import type { Session } from '../types/session'
import { imeComposing } from '../utils/ime-composing'
import { targetIndex } from '../utils/reorder'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { AgentStatusBadge } from './agent-status-badge'
import { IconSheet } from './icon-picker'
import { onlyPaneOf } from './meta-chips'
import { NewTabForm } from './new-tab-form'
import { TabIcon } from './tab-icon'
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
  // customIcon false: back to the automatic icon
  onUpdate?: (
    id: string,
    updates: { name?: string; icon?: string; customIcon?: boolean },
  ) => void
  // The backend can rename this tab (caps.renameTab); false: only its icon
  renameTab?: boolean
  // The room left after the last tab (and Add) in px, negative while the
  // tabs overflow; called when it changes. Not called without ResizeObserver.
  onSpareChange?: (spare: number) => void
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

// How far (px) a pressed tab moves before it drags
const DRAG_SLOP = 4
// How long (ms) a dropped tab waits in its new place for the new order
const HOLD_MS = 5000

// Browser-style tabs in the desktop header row. A tab is a role="tab"
// button; its close button is a sibling, never nested in it, and Add sits
// outside the tablist. Arrow keys move focus between tabs; Enter or Space
// switches, since every switch is a request to the backend; Delete closes the
// focused tab, so the close buttons stay out of the tab order. With onMove,
// a tab drags along the row, the others making room for it.
// A new tab fades in; a closed one fades out, inert and out of the tab order
// and of dragging, then the others close up.
// A right click, Shift+F10 or the menu key opens a tab's menu: rename (F2,
// in place), icon, move (Alt+Left/Right), a new tab with a name (N), close.
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
  onSpareChange,
}: Props) {
  const { t } = useT()
  const rowRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScrollX(scrollRef)
  const addRef = useRef<HTMLButtonElement>(null)
  // The spare room, measured again when the row is resized and after every
  // render (a tab added, closed or renamed changes the tabs' width only)
  const spareChange = useRef(onSpareChange)
  spareChange.current = onSpareChange
  const lastSpare = useRef<number | null>(null)
  const reportSpare = useRef(() => {
    const report = spareChange.current
    const row = rowRef.current
    const list = scrollRef.current
    if (!report || !row || !list || typeof ResizeObserver === 'undefined')
      return
    const end = (addRef.current ?? list).getBoundingClientRect().right
    const spare = Math.round(
      row.getBoundingClientRect().right -
        end -
        (list.scrollWidth - list.clientWidth),
    )
    if (spare === lastSpare.current) return
    lastSpare.current = spare
    report(spare)
  })
  useLayoutEffect(() => reportSpare.current())
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => reportSpare.current())
    ro.observe(rowRef.current!)
    ro.observe(scrollRef.current!)
    return () => ro.disconnect()
  }, [])
  const activeRef = useRef<HTMLButtonElement>(null)
  // Ends a drag in progress (its window listeners), also on unmount
  const endDrag = useRef<(() => void) | null>(null)
  // What a drag reads when it moves and lands: the tabs can change meanwhile
  const latest = useRef({ sessions, onMove })
  latest.current = { sessions, onMove }
  useEffect(() => () => endDrag.current?.(), [])
  // A dropped tab and the ones that made room stay where they were drawn
  // until the server's new order arrives; then they are let go
  const held = useRef<{ tabs: HTMLElement[]; timer: number } | null>(null)
  const letGo = useRef((animate: boolean) => {
    const h = held.current
    if (!h) return
    held.current = null
    clearTimeout(h.timer)
    for (const tab of h.tabs) {
      // Drawn in its new place in this frame: no slide from the old one
      if (!animate) tab.style.transition = 'none'
      tab.style.translate = ''
    }
    if (animate) return
    void scrollRef.current?.offsetWidth
    for (const tab of h.tabs) tab.style.transition = ''
  })
  const order = sessions.map(lastingKey).join('\n')
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new order lets the tabs go
  useLayoutEffect(() => letGo.current(false), [order])
  // A move that ends without a new order (refused): the tabs slide back
  const wasMoving = useRef(moving)
  useEffect(() => {
    if (wasMoving.current && !moving) letGo.current(true)
    wasMoving.current = moving
  }, [moving])
  useEffect(() => () => letGo.current(false), [])
  // By a tab's lasting key: a tmux move renumbers the windows, and a tab
  // keyed by its id would fade out and in again
  const { entries, ref } = usePresenceList(sessions, lastingKey)
  const isNew = useNewKeys(sessions.map(lastingKey))
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
  const refocusRing = useRef(true)
  // Only when the focus was lost: one taken elsewhere meanwhile (a click in
  // the terminal during a slow move) stays there
  useEffect(() => {
    const key = refocus.current
    if (!key || renaming || moving) return
    refocus.current = null
    const ring = refocusRing.current
    refocusRing.current = true
    const now = document.activeElement
    if (now !== document.body && !scrollRef.current!.contains(now)) return
    tabButtons.current.get(key)?.focus({ focusVisible: ring })
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
  // The tab renamed gets the focus back with a ring only when the rename
  // was started from the keyboard: the Enter that saves it is a key, so a
  // rename started with a pointer would ring the tab too
  const renameByKey = useRef(false)
  const startRename = (session: Session, byKey: boolean) => {
    renameByKey.current = byKey
    setDraft(session.name)
    setRenaming(session.id)
  }
  const endRename = (save: boolean) => {
    // The field is drawn only for a tab still here (a leaving one is inert)
    const session = sessions.find((s) => s.id === renaming)!
    const name = draft.trim()
    if (save && name && name !== session.name) onUpdate!(session.id, { name })
    refocus.current = lastingKey(session)
    refocusRing.current = renameByKey.current
    setRenaming(null)
  }
  const step = (id: string, delta: -1 | 1) => {
    const index = targetIndex(ids, id, delta)
    if (index === null) return
    refocus.current = lastingKey(sessions[ids.indexOf(id)])
    onMove!(id, index)
  }
  // The form opened from a tab's menu gives the focus back to that tab,
  // from + to +
  const formFrom = useRef<HTMLElement | null>(null)
  const formName = useRef<HTMLInputElement>(null)
  const openForm = (from: HTMLElement | null) => {
    formFrom.current = from
    // Already open: its name field takes the focus again
    if (formOpen) formName.current!.focus()
    else setFormOpen(true)
  }
  const closeForm = (byPress = false) => {
    setFormOpen(false)
    if (!byPress) formFrom.current?.focus()
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
      startRename(sessions[at], true)
      return
    }
    // N, the key where it is on any layout: a new tab with a name. Only on
    // a focused tab, so no typing and no browser key is taken.
    if (
      e.code === 'KeyN' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      if (!onAdd) return
      e.preventDefault()
      openForm(tabs[at])
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

  // Dragging (desktop, a mouse or a pen), like a browser's tabs: the tab
  // slides along the row only, held inside the strip, never over the page,
  // and the others slide aside to make room where it would land. A press
  // that moves less than DRAG_SLOP is still a click.
  const movable = !!onMove && sessions.length > 1
  const dragProps = (id: string) => {
    if (!movable) return {}
    return {
      'data-movable': true,
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (
          e.button !== 0 ||
          e.pointerType === 'touch' ||
          endDrag.current ||
          held.current ||
          moving
        )
          return
        // The close button closes; it does not drag
        if ((e.target as HTMLElement).closest('button:not([role="tab"])'))
          return
        startDrag(id, e.currentTarget, e.clientX)
      },
    }
  }
  const startDrag = (id: string, el: HTMLElement, startX: number) => {
    const list = scrollRef.current!
    // Set when the drag starts: the tabs still here, in the sessions'
    // order, their boxes without any slide, and the room the dragged one
    // takes (its width and the gap after it)
    let tabs: HTMLElement[] = []
    let boxes: DOMRect[] = []
    let from = -1
    let to = -1
    let room = 0
    const begin = () => {
      tabs = [...list.children].filter(
        (c): c is HTMLElement =>
          c instanceof HTMLElement && !c.hasAttribute('data-leaving'),
      )
      boxes = tabs.map((t) => t.getBoundingClientRect())
      from = tabs.indexOf(el)
      to = from
      room =
        boxes[from].width +
        (Number.parseFloat(getComputedStyle(list).columnGap) || 0)
      el.setAttribute('data-dragging', 'true')
      // A focus ring would follow the tab around
      if (el.contains(document.activeElement))
        (document.activeElement as HTMLElement).blur()
    }
    const onMoveEvent = (ev: globalThis.PointerEvent) => {
      const dx = ev.clientX - startX
      if (from === -1) {
        if (Math.abs(dx) < DRAG_SLOP) return
        begin()
      }
      const box = list.getBoundingClientRect()
      const self = boxes[from]
      const x = Math.min(
        Math.max(dx, box.left - self.left),
        box.right - self.right,
      )
      el.style.translate = `${x}px 0`
      // Its place: past every tab whose middle its leading edge has crossed
      // (at an end of the strip, past the tab there, whatever their widths)
      const left = self.left + x
      const right = self.right + x
      to = boxes.filter((b, i) => {
        const middle = b.left + b.width / 2
        return i < from ? middle < left : i > from && middle <= right
      }).length
      tabs.forEach((tab, i) => {
        if (i === from) return
        const shift =
          i > from && i <= to ? -room : i < from && i >= to ? room : 0
        tab.style.translate = shift ? `${shift}px 0` : ''
      })
    }
    const finish = (drop: boolean) => {
      window.removeEventListener('pointermove', onMoveEvent)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      endDrag.current = null
      el.removeAttribute('data-dragging')
      if (from === -1) return
      // The click that ends a drag (fired in the same task as the release,
      // when it is over the tab) does not select the tab
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true))
      const { sessions: now, onMove: move } = latest.current
      // The tabs changed under the drag: their places no longer hold
      const same = now.length === tabs.length && now[from]?.id === id && !!move
      if (!drop || to === from || !same) {
        for (const tab of tabs) tab.style.translate = ''
        return
      }
      // Into its slot, the others still aside, until the new order
      const slot =
        to > from
          ? boxes[to].right - boxes[from].right
          : boxes[to].left - boxes[from].left
      el.style.translate = `${slot}px 0`
      held.current = {
        tabs,
        // In case no order and no end of a move ever comes
        timer: window.setTimeout(() => letGo.current(true), HOLD_MS),
      }
      move(id, to)
    }
    const swallow = (c: MouseEvent) => {
      c.stopPropagation()
      c.preventDefault()
    }
    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    // Escape puts the tab back
    const onKey = (k: globalThis.KeyboardEvent) => {
      if (k.key !== 'Escape' || from === -1) return
      k.preventDefault()
      k.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', onMoveEvent)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    endDrag.current = () => finish(false)
  }

  return (
    <div
      ref={rowRef}
      className="relative flex min-w-0 flex-1 items-end gap-1 self-stretch"
    >
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
            onAdd && 'N',
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
              className={`group relative flex h-9 shrink-0 items-center pr-1.5 text-[13px] transition-[color,background-color,border-color,opacity,translate,scale] duration-(--duration-fast) ease-standard motion-safe:active:scale-[0.98] data-dragging:z-20 data-dragging:transition-none ${isNew(key) ? ENTER_FROM : ''} ${leaving ? LEAVE_TO : ''} ${
                looksActive
                  ? 'pointer-coarse:h-11 rounded-t-control border border-b-0 border-border bg-term text-fg shadow-sm ui-terminal:shadow-[inset_0_2px_0_var(--color-accent)] ui-native:rounded-t-panel ui-native:border-0'
                  : 'mb-0.5 h-8 pointer-coarse:h-10 rounded-control text-fg-muted hover:bg-surface-raised hover:text-fg data-dragging:bg-surface-raised data-dragging:text-fg'
              }`}
            >
              {renaming === session.id ? (
                <span className="flex h-full items-center gap-2 pl-3 pr-1">
                  <span className="text-base leading-none">
                    <TabIcon session={session} />
                  </span>
                  <input
                    type="text"
                    aria-label={t('shell.tabs.renameField', {
                      name: session.name,
                    })}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter or Escape that ends an IME composition
                      if (imeComposing(e)) return
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
                    // A closed tab fading out is not the one to focus
                    if (leaving) return
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
                  className={`flex h-full select-none items-center gap-2 whitespace-nowrap rounded-control pl-3 pr-1 ${FOCUS_RING} focus-visible:-outline-offset-2`}
                >
                  <span className="text-base leading-none">
                    <TabIcon session={session} />
                  </span>
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
          // Not a press outside the form: + itself closes it, where it is
          // the one that opens it
          data-new-tab-toggle={askName || undefined}
          onClick={addTab}
          aria-expanded={askName ? formOpen : undefined}
          className="mb-0.5"
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
          nameRef={formName}
          toggleSelector={askName ? '[data-new-tab-toggle]' : undefined}
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
                onSelect={(e) => startRename(menuSession, e.byKey)}
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
            <MenuItem
              // i18n-ignore: a key's name
              shortcut={{ label: 'N', aria: 'N' }}
              onSelect={() => openForm(menuAnchor.current)}
            >
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
          value={iconSession?.customIcon ? iconSession.icon : ''}
          onClose={() => setIconFor(null)}
          onSelect={(icon) => {
            onUpdate(iconSession!.id, { icon })
            setIconFor(null)
          }}
          auto={!iconSession?.customIcon}
          onAuto={() => {
            onUpdate(iconSession!.id, { customIcon: false })
            setIconFor(null)
          }}
        />
      )}
    </div>
  )
}

const lastingKey = (s: Session) => s.key ?? s.id
