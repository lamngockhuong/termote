import { Plus, X } from 'lucide-react'
import {
  type KeyboardEvent,
  type PointerEvent,
  type Ref,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ENTER_FROM, useNewKeys } from '../hooks/use-new-keys'
import { LEAVE_TO, usePresenceList } from '../hooks/use-presence-list'
import { useWheelScrollX } from '../hooks/use-wheel-scroll-x'
import { useT } from '../i18n/i18n-context'
import type { Session } from '../types/session'
import { imeComposing } from '../utils/ime-composing'
import { slidePlace, slideShift, targetIndex } from '../utils/reorder'
import {
  collapsedKey,
  dropGroup,
  dropTabIndex,
  joinTabGroup,
  readCollapsed,
  type StripItem,
  splitTabGroup,
  stripItems,
  type TabGroup,
  tabGroupFill,
  tabGroupLine,
  tabGroupMoveIndex,
  writeCollapsed,
} from '../utils/tab-group'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { AgentStatusBadge } from './agent-status-badge'
import { IconSheet } from './icon-picker'
import { onlyPaneOf } from './meta-chips'
import { NewTabForm } from './new-tab-form'
import { TabIcon } from './tab-icon'
import { FOCUS_RING, IconButton } from './ui/button'
import { Menu, MenuGroup, MenuItem, MenuSeparator } from './ui/menu'

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
  // customIcon false: back to the automatic icon. Settles once done: a
  // group's tabs are renamed one after the other
  onUpdate?: (
    id: string,
    updates: { name?: string; icon?: string; customIcon?: boolean },
  ) => unknown
  // The backend can rename this tab (caps.renameTab); false: only its icon
  renameTab?: boolean
  // The room left after the last tab (and Add) in px, negative while the
  // tabs overflow; called when it changes. Not called without ResizeObserver.
  onSpareChange?: (spare: number) => void
  // Tab groups, like a browser's (utils/tab-group.ts): "review/PR 1" is the
  // tab "PR 1" of the group "review", shown after the group's coloured name
  // with the group's tabs. The workspace keys which groups this browser
  // keeps collapsed.
  tabGroups?: boolean
  workspace?: string
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
// in place), icon, tab group, move (Alt+Left/Right), a new tab with a name
// (N), close.
// With tabGroups, a group's tabs follow its coloured name, which a click
// collapses or expands and whose menu (the same keys) adds a tab to it,
// renames it, or ungroups its tabs; the arrow keys reach it like a tab. A
// tab dragged after a group's name or between two of its tabs joins that
// group, and one dragged away from its own group leaves it.
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
  tabGroups = false,
  workspace,
}: Props) {
  const { t } = useT()
  // The groups this browser keeps collapsed (collapsedKey)
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const setFolded = (group: string, fold: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      const key = collapsedKey(workspace, group)
      if (fold) next.add(key)
      else next.delete(key)
      writeCollapsed(next)
      return next
    })
  // What the bar shows, in its order: with tab groups, each group's name
  // before its tabs; else the tabs. The same objects while nothing changes:
  // the presence list compares them.
  const layOut = (list: readonly Session[]): StripItem[] =>
    tabGroups
      ? stripItems(
          list,
          (g) => collapsed.has(collapsedKey(workspace, g)),
          activeId,
        )
      : list.map((s) => ({ kind: 'tab', key: lastingKey(s), session: s }))
  // biome-ignore lint/correctness/useExhaustiveDependencies: layOut reads these
  const items = useMemo(
    () => layOut(sessions),
    [tabGroups, sessions, collapsed, workspace, activeId],
  )
  // Whether the tab id moved to place to in the server's order changes what
  // the bar shows: a group's tabs are gathered, so many places show the same
  const showsMove = (id: string, to: number) => {
    const list = sessions.filter((s) => s.id !== id)
    list.splice(to, 0, sessions.find((s) => s.id === id)!)
    return layOut(list).map(stripKey).join('\n') !== order
  }
  // The tabs shown, in the bar's order, which places, the menu and the
  // keys count in
  const shown = useMemo(
    () => items.flatMap((it) => (it.kind === 'tab' ? [it.session] : [])),
    [items],
  )
  const groupNames = useMemo(
    () => items.flatMap((it) => (it.kind === 'group' ? [it.group.name] : [])),
    [items],
  )
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
  const latest = useRef({ items, shown, sessions, onMove, onUpdate, showsMove })
  latest.current = { items, shown, sessions, onMove, onUpdate, showsMove }
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
  const order = items.map(stripKey).join('\n')
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
  const { entries, ref } = usePresenceList(items, stripKey)
  const isNew = useNewKeys(items.map(stripKey))
  // By a tab's lasting key: a tmux tab's id is its window number, which a
  // move renumbers
  const tabButtons = useRef(new Map<string, HTMLButtonElement>())
  // A group's name, by the group's
  const groupButtons = useRef(new Map<string, HTMLButtonElement>())
  // The tab or group the menu was asked on, which it hangs from
  const menuAnchor = useRef<HTMLElement | null>(null)
  const [menu, setMenu] = useState<{ id: string; byKey: boolean } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{
    name: string
    byKey: boolean
  } | null>(null)
  // The group whose name is edited in place, and the field's text
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [iconFor, setIconFor] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [formGroup, setFormGroup] = useState<string>()
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
    const el = key.startsWith('\0')
      ? groupButtons.current.get(key.slice(1))
      : tabButtons.current.get(key)
    el?.focus({ focusVisible: ring })
  })

  const canRename = !!onUpdate && renameTab
  const ids = shown.map((s) => s.id)
  const hasMenu = !!onUpdate || !!onAdd || !!onMove || canRemove
  const openMenu = (id: string, byKey: boolean) => {
    // Asked from the tab's own button, which is there
    menuAnchor.current = tabButtons.current.get(
      lastingKey(sessions.find((s) => s.id === id)!),
    )!
    setMenu({ id, byKey })
  }
  const openGroupMenu = (name: string, byKey: boolean) => {
    menuAnchor.current = groupButtons.current.get(name)!
    setGroupMenu({ name, byKey })
  }
  // The tab renamed gets the focus back with a ring only when the rename
  // was started from the keyboard: the Enter that saves it is a key, so a
  // rename started with a pointer would ring the tab too
  const renameByKey = useRef(false)
  // The field asks for a new tab group of the tab, not for its name
  const [namingGroup, setNamingGroup] = useState(false)
  // With tab groups a tab's name is edited without its group's, which its
  // group's name shows
  const editedName = (session: Session) =>
    tabGroups ? splitTabGroup(session.name).label : session.name
  const startRename = (session: Session, byKey: boolean, group = false) => {
    renameByKey.current = byKey
    setNamingGroup(group)
    setDraft(group ? '' : editedName(session))
    setRenaming(session.id)
  }
  // Into the group (unset: out of any), by its name
  const moveToGroup = (session: Session, to?: string) =>
    onUpdate!(session.id, {
      name: joinTabGroup(to, splitTabGroup(session.name).label),
    })
  const endRename = (save: boolean) => {
    // The field is drawn only for a tab still here (a leaving one is inert)
    const session = sessions.find((s) => s.id === renaming)!
    const typed = draft.trim()
    const name =
      tabGroups && typed
        ? joinTabGroup(splitTabGroup(session.name).group, typed)
        : typed
    if (save && typed && namingGroup) moveToGroup(session, typed)
    else if (save && name && name !== session.name)
      onUpdate!(session.id, { name })
    refocus.current = lastingKey(session)
    refocusRing.current = renameByKey.current
    setRenaming(null)
  }
  const step = (id: string, delta: -1 | 1) => {
    const index = targetIndex(ids, id, delta)
    if (index === null) return
    const session = shown[ids.indexOf(id)]
    const group = tabGroups ? splitTabGroup(session.name).group : undefined
    const to = tabGroupMoveIndex(sessions, shown, id, index, group)
    if (!showsMove(id, to)) return
    refocus.current = lastingKey(session)
    onMove!(id, to)
  }
  // A group's tabs renamed one after the other, each by name(tab)
  const renameAll = async (list: Session[], name: (s: Session) => string) => {
    for (const s of list) await onUpdate!(s.id, { name: name(s) })
  }
  const startGroupRename = (name: string) => {
    setGroupDraft(name)
    setRenamingGroup(name)
  }
  const endGroupRename = (save: boolean) => {
    const from = renamingGroup!
    const to = groupDraft.trim()
    setRenamingGroup(null)
    refocus.current = `\0${from}`
    const group = items.find(
      (it) => it.kind === 'group' && it.group.name === from,
    )
    if (!save || !to || to === from || group?.kind !== 'group') return
    // Its folding goes with it
    setFolded(to, group.group.collapsed)
    setFolded(from, false)
    void renameAll(group.group.sessions, (s) =>
      joinTabGroup(to, splitTabGroup(s.name).label),
    )
  }
  const ungroup = (group: TabGroup) => {
    setFolded(group.name, false)
    void renameAll(group.sessions, (s) => splitTabGroup(s.name).label)
  }
  // The form opened from a tab's menu gives the focus back to that tab,
  // from + to +
  const formFrom = useRef<HTMLElement | null>(null)
  const formName = useRef<HTMLInputElement>(null)
  // group: the one the form starts with (default: the tab on screen's)
  const openForm = (from: HTMLElement | null, group?: string) => {
    formFrom.current = from
    setFormGroup(group)
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

  // The keys of a group's name: its menu, a rename, a new tab in it
  const onGroupKey = (e: KeyboardEvent, name: string, el: HTMLElement) => {
    if (menuKey(e)) {
      e.preventDefault()
      openGroupMenu(name, true)
      return true
    }
    if (e.key === 'F2' && canRename) {
      e.preventDefault()
      startGroupRename(name)
      return true
    }
    if (e.code === 'KeyN' && !e.ctrlKey && !e.metaKey && !e.altKey && onAdd) {
      e.preventDefault()
      openForm(el, name)
      return true
    }
    return false
  }

  // The keys of a focused tab: its menu, a rename, a new tab, a move, close.
  // True when one was taken.
  const onTabKey = (e: KeyboardEvent, session: Session, el: HTMLElement) => {
    const id = session.id
    if (menuKey(e)) {
      if (!hasMenu) return true
      e.preventDefault()
      openMenu(id, true)
      return true
    }
    if (e.key === 'F2') {
      if (!canRename) return true
      e.preventDefault()
      startRename(session, true)
      return true
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
      if (!onAdd) return true
      e.preventDefault()
      openForm(el)
      return true
    }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      // Alt+Left would also go back a page, where tabs cannot move too
      e.preventDefault()
      if (onMove) step(id, e.key === 'ArrowLeft' ? -1 : 1)
      return true
    }
    if (e.key === 'Delete') {
      if (!canRemove) return true
      e.preventDefault()
      onRemove(id)
      return true
    }
    return false
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // A closed tab or group still fading out is not one of them; a group's
    // name is reached like a tab
    const stops = [
      ...scrollRef.current!.querySelectorAll<HTMLElement>(
        '[role="tab"], [data-group-chip]',
      ),
    ].filter((el) => !el.closest('[data-leaving]'))
    const focused = document.activeElement as HTMLElement
    const from = stops.indexOf(focused)
    if (from === -1) return
    const chip = focused.dataset.groupChip
    if (chip !== undefined) {
      if (onGroupKey(e, chip, focused)) return
    } else {
      const at = stops
        .filter((el) => el.getAttribute('role') === 'tab')
        .indexOf(focused)
      if (onTabKey(e, shown[at], focused)) return
    }
    const last = stops.length - 1
    const next = {
      ArrowRight: from === last ? 0 : from + 1,
      ArrowLeft: from === 0 ? last : from - 1,
      Home: 0,
      End: last,
    }[e.key]
    if (next === undefined) return
    e.preventDefault()
    stops[next].focus()
  }

  const menuAt = menu ? ids.indexOf(menu.id) : -1
  // A tab closed while its menu is open takes the menu with it
  const menuSession = menuAt === -1 ? undefined : shown[menuAt]
  const menuGroup = menuSession && splitTabGroup(menuSession.name).group
  // A group gone while its menu is open takes the menu with it
  const groupMenuItem = groupMenu
    ? items.find(
        (it) => it.kind === 'group' && it.group.name === groupMenu.name,
      )
    : undefined
  const menuOfGroup =
    groupMenuItem?.kind === 'group' ? groupMenuItem.group : undefined
  const iconSession = sessions.find((s) => s.id === iconFor)

  // Dragging (desktop, a mouse or a pen), like a browser's tabs: the tab
  // slides along the row only, held inside the strip, never over the page,
  // and the others slide aside to make room where it would land. A press
  // that moves less than DRAG_SLOP is still a click. With tab groups the
  // groups' names make room too, and where it lands decides its group.
  const regroups = tabGroups && canRename
  const movable = (!!onMove || regroups) && items.length > 1
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
    // Set when the drag starts: the tabs (and groups' names) still here, in
    // the bar's order, their boxes without any slide, and the room the dragged one
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
      to = slidePlace(boxes, from, x)
      tabs.forEach((tab, i) => {
        if (i === from) return
        const shift = slideShift(i, from, to, room)
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
      const {
        items: now,
        shown: nowShown,
        sessions: all,
        onMove: move,
        onUpdate: update,
        showsMove: shows,
      } = latest.current
      const dragged = now[from]
      // The tabs changed under the drag: their places no longer hold
      const same =
        now.length === tabs.length &&
        dragged?.kind === 'tab' &&
        dragged.session.id === id
      const putBack = () => {
        for (const tab of tabs) tab.style.translate = ''
      }
      if (!drop || to === from || !same) return putBack()
      // Its group where it lands, and its place among the tabs
      const group = regroups ? dropGroup(now, from, to) : dragged.group
      const regroup = group !== dragged.group
      // In the server's order, asked before a rename changes the bar's
      const target = tabGroupMoveIndex(
        all,
        nowShown,
        id,
        dropTabIndex(now, from, to),
        group,
      )
      // A move that changes nothing on the bar is not asked; with a new
      // group, one to the tab's place among its group's
      const shifts =
        !!move &&
        target !== all.findIndex((s) => s.id === id) &&
        (regroup || shows(id, target))
      if (!regroup && !shifts) return putBack()
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
      if (!regroup) {
        move!(id, target)
        return
      }
      // Renamed first: a move renumbers a tmux tab, a rename keeps its id
      void Promise.resolve(
        update!(id, {
          name: joinTabGroup(group, splitTabGroup(dragged.session.name).label),
        }),
      ).then(() => shifts && move!(id, target))
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
        {entries.map(({ item, key, leaving }) => {
          if (item.kind === 'group')
            return (
              <GroupName
                key={key}
                ref={ref(key)}
                group={item.group}
                leaving={leaving}
                entering={isNew(key)}
                buttonRef={(el) => {
                  if (leaving) return
                  if (el) groupButtons.current.set(item.group.name, el)
                  else groupButtons.current.delete(item.group.name)
                }}
                onToggle={() =>
                  setFolded(item.group.name, !item.group.collapsed)
                }
                onMenu={() => openGroupMenu(item.group.name, false)}
                keys={['Shift+F10', canRename && 'F2', onAdd && 'N']
                  .filter(Boolean)
                  .join(' ')}
                renaming={
                  renamingGroup === item.group.name
                    ? {
                        draft: groupDraft,
                        onDraft: setGroupDraft,
                        onEnd: endGroupRename,
                        onCancel: () => setRenamingGroup(null),
                      }
                    : undefined
                }
              />
            )
          const { session, group } = item
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
              className={`group relative flex h-9 shrink-0 items-center pr-1.5 text-[13px] ${group === undefined ? '' : `after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full ${tabGroupLine(group)}`} transition-[color,background-color,border-color,opacity,translate,scale] duration-(--duration-fast) ease-standard motion-safe:active:scale-[0.98] data-dragging:z-20 data-dragging:transition-none ${isNew(key) ? ENTER_FROM : ''} ${leaving ? LEAVE_TO : ''} ${
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
                    aria-label={t(
                      namingGroup
                        ? 'shell.tabGroups.nameField'
                        : 'shell.tabs.renameField',
                      { name: session.name },
                    )}
                    placeholder={
                      namingGroup ? t('shell.tabGroups.new') : undefined
                    }
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
                    {visibleUnsafe(editedName(session))}
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
          groups={tabGroups ? groupNames : undefined}
          group={
            formGroup ??
            splitTabGroup(sessions.find((s) => s.id === activeId)?.name ?? '')
              .group
          }
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
          {tabGroups && canRename && (
            <MenuGroup label={t('shell.tabGroups.addTo')}>
              {groupNames
                .filter((g) => g !== menuGroup)
                .map((g) => (
                  <MenuItem
                    key={g}
                    onSelect={() => moveToGroup(menuSession, g)}
                  >
                    {visibleUnsafe(g)}
                  </MenuItem>
                ))}
              <MenuItem
                onSelect={(e) => startRename(menuSession, e.byKey, true)}
              >
                {t('shell.tabGroups.new')}
              </MenuItem>
              {menuGroup !== undefined && (
                <MenuItem onSelect={() => moveToGroup(menuSession)}>
                  {t('shell.tabGroups.remove')}
                </MenuItem>
              )}
            </MenuGroup>
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
                disabled={menuAt === shown.length - 1}
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
      {menuOfGroup && (
        <Menu
          label={t('shell.tabGroups.menu', { name: menuOfGroup.name })}
          trigger={null}
          anchorRef={menuAnchor}
          focusFirst={groupMenu!.byKey}
          align="start"
          open
          onOpenChange={(open) => !open && setGroupMenu(null)}
        >
          {onAdd && (
            <MenuItem
              // i18n-ignore: a key's name
              shortcut={{ label: 'N', aria: 'N' }}
              onSelect={() => openForm(menuAnchor.current, menuOfGroup.name)}
            >
              {t('shell.tabGroups.newTab')}
            </MenuItem>
          )}
          {canRename && (
            <MenuItem
              // i18n-ignore: a key's name
              shortcut={{ label: 'F2', aria: 'F2' }}
              onSelect={() => startGroupRename(menuOfGroup.name)}
            >
              {t('shell.tabGroups.rename')}
            </MenuItem>
          )}
          <MenuItem
            onSelect={() => setFolded(menuOfGroup.name, !menuOfGroup.collapsed)}
          >
            {t(
              menuOfGroup.collapsed
                ? 'shell.tabGroups.expand'
                : 'shell.tabGroups.collapse',
            )}
          </MenuItem>
          {canRename && (
            <>
              <MenuSeparator />
              <MenuItem onSelect={() => ungroup(menuOfGroup)}>
                {t('shell.tabGroups.ungroup')}
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
const stripKey = (it: StripItem) => it.key

interface GroupNameProps {
  group: TabGroup
  // Removed from the bar: fading out, inert
  leaving: boolean
  // Just added: fading in
  entering: boolean
  buttonRef: (el: HTMLButtonElement | null) => void
  onToggle: () => void
  onMenu: () => void
  // Its keys, for aria-keyshortcuts
  keys: string
  // Set: its name is edited in place
  renaming?: {
    draft: string
    onDraft: (draft: string) => void
    onEnd: (save: boolean) => void
    onCancel: () => void
  }
  ref: Ref<HTMLDivElement>
}

// A tab group's coloured name in the bar, before its tabs. A click
// collapses or expands it; collapsed, it also counts its tabs and shows the
// heaviest agent status among them. Right click: its menu.
function GroupName({
  group,
  leaving,
  entering,
  buttonRef,
  onToggle,
  onMenu,
  keys,
  renaming,
  ref,
}: GroupNameProps) {
  const { t } = useT()
  const name = visibleUnsafe(group.name)
  const label = t('shell.tabGroups.chip', {
    name,
    count: group.sessions.length,
  })
  return (
    <div
      ref={ref}
      inert={leaving}
      aria-hidden={leaving || undefined}
      data-leaving={leaving || undefined}
      onContextMenu={(e) => {
        if (leaving || renaming) return
        e.preventDefault()
        onMenu()
      }}
      className={`mb-0.5 flex h-8 shrink-0 items-center px-0.5 transition-[opacity,translate,scale] duration-(--duration-fast) ease-standard pointer-coarse:h-10 ${entering ? ENTER_FROM : ''} ${leaving ? LEAVE_TO : ''}`}
    >
      {renaming ? (
        <input
          type="text"
          aria-label={t('shell.tabGroups.renameField', { name: group.name })}
          value={renaming.draft}
          onChange={(e) => renaming.onDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter or Escape that ends an IME composition
            if (imeComposing(e)) return
            if (e.key !== 'Enter' && e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            renaming.onEnd(e.key === 'Enter')
          }}
          onBlur={renaming.onCancel}
          autoFocus
          className="h-6 w-[120px] min-w-0 rounded-full border border-accent bg-bg px-2 text-[12px] text-fg outline-none"
        />
      ) : (
        <button
          ref={buttonRef}
          type="button"
          data-group-chip={group.name}
          tabIndex={-1}
          aria-expanded={!group.collapsed}
          aria-label={label}
          aria-keyshortcuts={keys}
          title={label}
          onClick={onToggle}
          className={`flex h-6 max-w-[180px] select-none items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium text-white ${tabGroupFill(group.name)} ${FOCUS_RING}`}
        >
          <span className="truncate ui-terminal:font-label">{name}</span>
          {group.collapsed && (
            <>
              <span className="text-[11px] opacity-80">
                {group.sessions.length}
              </span>
              <AgentStatusBadge status={group.agentStatus} size={11} />
            </>
          )}
        </button>
      )}
    </div>
  )
}
