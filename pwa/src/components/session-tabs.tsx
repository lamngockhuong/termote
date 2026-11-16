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
  dropWant,
  groupMoveOrder,
  joinTabGroup,
  moveSteps,
  nearestMove,
  readCollapsed,
  type StripItem,
  solveTabMove,
  splitTabGroup,
  stepWant,
  stripItems,
  stripUnits,
  type TabGroup,
  type TabMove,
  tabGroupFill,
  tabGroupLine,
  validGroupName,
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
  // Settles once done: a group's tabs move one after the other
  onMove?: (id: string, index: number) => unknown
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
// How long (ms) a group's move waits for each of its tabs to show moved
const STEP_WAIT_MS = 5000

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
  // How the server's order is to change for the bar to show want, the tab
  // id renamed to name first: undefined when no single move does it
  const plan = (
    id: string,
    name: string,
    want: readonly StripItem[],
  ): TabMove | null | undefined =>
    solveTabMove(
      sessions.map((s) => (s.id === id ? { ...s, name } : s)),
      want,
      layOut,
      id,
    )
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
  // A tab renamed into or out of a group by a drag or its keys, its move
  // still to be asked: no other drag starts meanwhile
  const regrouping = useRef(false)
  // The tabs as last drawn, and what waits for them to change: a group moved
  // one tab at a time finds each next tab by its lasting key, since a tmux
  // move renumbers the windows
  const drawn = useRef(sessions)
  drawn.current = sessions
  const redrawn = useRef<(() => void)[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: new tabs wake the waiters
  useEffect(() => {
    for (const wake of redrawn.current.splice(0)) wake()
  }, [sessions])
  const runSteps = async (steps: { key: string; index: number }[]) => {
    regrouping.current = true
    try {
      for (const { key, index } of steps) {
        const tab = drawn.current.find((s) => lastingKey(s) === key)
        if (!tab) return
        await onMove!(tab.id, index)
        // Until the tabs drawn show it there (a refused move: never)
        const there = () =>
          drawn.current.findIndex((s) => lastingKey(s) === key) === index
        const until = Date.now() + STEP_WAIT_MS
        while (!there() && Date.now() < until)
          await new Promise<void>((wake) => {
            redrawn.current.push(wake)
            setTimeout(wake, 100)
          })
        if (!there()) return
      }
    } finally {
      regrouping.current = false
    }
  }
  // A group moved to place to among the bar's units (stripUnits): one move
  // where one is enough, else its tabs one after the other
  const moveGroup = (name: string, to: number) => {
    const units = stripUnits(items)
    const from = units.findIndex(
      (u) => u[0].kind === 'group' && u[0].group.name === name,
    )
    const order = [...units]
    const [unit] = order.splice(from, 1)
    order.splice(to, 0, unit)
    const first = sessions.find((s) => splitTabGroup(s.name).group === name)!
    const one = solveTabMove(sessions, order.flat(), layOut, first.id)
    if (one) {
      onMove!(one.id, one.index)
      return
    }
    void runSteps(
      moveSteps(sessions, groupMoveOrder(sessions, name, order[to + 1]?.[0])),
    )
  }
  // What a drag reads when it moves and lands: the tabs can change meanwhile
  const fresh = { items, sessions, onMove, onUpdate, plan, moveGroup }
  const latest = useRef(fresh)
  latest.current = fresh
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
  // A tab hidden by its group's folding goes at once (the others slide over
  // its place, toggleFold); a tab closed, or a group gone, fades out
  const { entries, ref } = usePresenceList(
    items,
    stripKey,
    (key) => !sessions.some((s) => lastingKey(s) === key),
  )
  // Folding a group, like a browser's: where each tab and group's name was
  // just before, by key, which they slide from to their new place (FLIP);
  // the tabs it shows again fade in
  const slideFrom = useRef<Map<string, number> | null>(null)
  const folded = useRef(false)
  const toggleFold = (group: string, fold: boolean) => {
    folded.current = true
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
      slideFrom.current = new Map(
        [...scrollRef.current!.querySelectorAll<HTMLElement>('[data-key]')].map(
          (el) => [el.dataset.key!, el.getBoundingClientRect().left],
        ),
      )
    setFolded(group, fold)
  }
  useLayoutEffect(() => {
    const from = slideFrom.current
    if (!from) return
    slideFrom.current = null
    const moved = [
      ...scrollRef.current!.querySelectorAll<HTMLElement>('[data-key]'),
    ].flatMap((el) => {
      const was = from.get(el.dataset.key!)
      const dx = was === undefined ? 0 : was - el.getBoundingClientRect().left
      if (!dx) return []
      el.style.transition = 'none'
      el.style.translate = `${dx}px 0`
      return [el]
    })
    if (!moved.length) return
    // Drawn where they were, then let go to slide to where they are
    void scrollRef.current!.offsetWidth
    for (const el of moved) {
      el.style.transition = ''
      el.style.translate = ''
    }
  })
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
  // Set: the bar's order the focus waits to change from (a group renamed or
  // ungrouped one tab after the other: its name, or its first tab, only
  // shows once the first is renamed)
  const refocusAfter = useRef<string | null>(null)
  // Only when the focus was lost: one taken elsewhere meanwhile (a click in
  // the terminal during a slow move) stays there
  useEffect(() => {
    const key = refocus.current
    if (!key || renaming || moving || refocusAfter.current === order) return
    const el = key.startsWith('\0')
      ? groupButtons.current.get(key.slice(1))
      : tabButtons.current.get(key)
    // A group's name not drawn yet: until the next order
    if (!el && refocusAfter.current !== null) {
      refocusAfter.current = order
      return
    }
    refocus.current = null
    refocusAfter.current = null
    const ring = refocusRing.current
    refocusRing.current = true
    const now = document.activeElement
    if (now !== document.body && !scrollRef.current!.contains(now)) return
    el?.focus({ focusVisible: ring })
  })

  const canRename = !!onUpdate && renameTab
  // The group of the tab id (unset: none, or tab groups off)
  const groupOfTab = (id: string) => {
    const s = sessions.find((x) => x.id === id)
    return tabGroups && s ? splitTabGroup(s.name).group : undefined
  }
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
    if (save && namingGroup && validGroupName(typed))
      moveToGroup(session, typed)
    else if (save && !namingGroup && name && name !== session.name)
      onUpdate!(session.id, { name })
    refocus.current = lastingKey(session)
    refocusRing.current = renameByKey.current
    setRenaming(null)
  }
  // A tab's rename (to name, into or out of a group) and then its move,
  // the move asked only once the rename is done and went through
  const regroupThenMove = (id: string, name: string, move?: TabMove | null) => {
    regrouping.current = true
    void Promise.resolve(onUpdate!(id, { name }))
      .then((ok) => {
        if (ok !== false && move) onMove!(move.id, move.index)
      })
      .finally(() => {
        regrouping.current = false
      })
  }
  // What a step of the tab id left or right asks, as a browser moves a tab
  // (utils/tab-group.ts stepWant); undefined: it cannot move that way
  const stepPlan = (id: string, delta: -1 | 1) => {
    const at = items.findIndex(
      (it) => it.kind === 'tab' && it.session.id === id,
    )
    const want = tabGroups
      ? stepWant(items, at, delta)
      : (() => {
          const index = targetIndex(ids, id, delta)
          if (index === null) return undefined
          const list = items.filter((_, i) => i !== at)
          list.splice(index, 0, items[at])
          return list
        })()
    if (!want) return undefined
    const tab = items[at] as Extract<StripItem, { kind: 'tab' }>
    const group = (
      want.find((it) => it.kind === 'tab' && it.session.id === id) as typeof tab
    ).group
    const regroup = group !== tab.group
    if (regroup && !regroups) return undefined
    const name = regroup
      ? joinTabGroup(group, splitTabGroup(tab.session.name).label)
      : tab.session.name
    const move = plan(id, name, want)
    if (move === undefined || (move && !onMove)) return undefined
    return { name: regroup ? name : undefined, move }
  }
  const step = (id: string, delta: -1 | 1) => {
    const todo = stepPlan(id, delta)
    if (!todo) return
    refocus.current = lastingKey(sessions.find((s) => s.id === id)!)
    if (todo.name !== undefined) regroupThenMove(id, todo.name, todo.move)
    else onMove!(todo.move!.id, todo.move!.index)
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
    if (!save || !validGroupName(to) || to === from || group?.kind !== 'group')
      return
    // The new name takes the focus once it shows
    refocus.current = `\0${to}`
    refocusAfter.current = order
    // Its folding goes with it, unless it joins a group there is
    if (!groupNames.includes(to)) setFolded(to, group.group.collapsed)
    setFolded(from, false)
    void renameAll(group.group.sessions, (s) =>
      joinTabGroup(to, splitTabGroup(s.name).label),
    )
  }
  const ungroup = (group: TabGroup) => {
    // Its first tab takes the focus once out of it
    refocus.current = lastingKey(group.sessions[0])
    refocusAfter.current = order
    setFolded(group.name, false)
    void renameAll(group.sessions, (s) => splitTabGroup(s.name).label)
  }
  // The form opened from a tab's menu gives the focus back to that tab,
  // from + to +
  const formFrom = useRef<HTMLElement | null>(null)
  const formName = useRef<HTMLInputElement>(null)
  // group: the one the form starts with (unset: none)
  const openForm = (from: HTMLElement | null, group: string | undefined) => {
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
    askName
      ? formOpen
        ? closeForm()
        : openForm(addRef.current, groupOfTab(activeId))
      : onAdd!()

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
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault()
      const units = stripUnits(items)
      const at = units.findIndex(
        (u) => u[0].kind === 'group' && u[0].group.name === name,
      )
      const to = at + (e.key === 'ArrowLeft' ? -1 : 1)
      if (onMove && to >= 0 && to < units.length) {
        refocus.current = `\0${name}`
        moveGroup(name, to)
      }
      return true
    }
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
    if (
      e.code === 'KeyN' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      onAdd
    ) {
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
      openForm(el, groupOfTab(id))
      return true
    }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      // Alt+Left would also go back a page, where tabs cannot move too
      e.preventDefault()
      step(id, e.key === 'ArrowLeft' ? -1 : 1)
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
          regrouping.current ||
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
        sessions: all,
        onMove: move,
        plan: planOf,
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
      // Its group where it lands, and the move that shows it where it was
      // dropped, in the server's order, asked before a rename changes the
      // bar's (none when no single move does it: the rename alone then)
      const group = regroups ? dropGroup(now, from, to) : dragged.group
      const regroup = group !== dragged.group
      const name = regroup
        ? joinTabGroup(group, splitTabGroup(dragged.session.name).label)
        : dragged.session.name
      const want = dropWant(now, from, to, group)
      const solved = planOf(id, name, want)
      const target = !move
        ? undefined
        : solved === undefined
          ? nearestMove(all, want, id)
          : solved
      if (!regroup && !target) return putBack()
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
        move!(target!.id, target!.index)
        return
      }
      // Renamed first: a move renumbers a tmux tab, a rename keeps its id
      regroupThenMove(id, name, target)
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

  // A group dragged by its name, as a browser's: its name and the tabs it
  // shows slide along the bar as one, the tabs in no group and the other
  // groups making room, and it lands between them, never inside a group
  const groupDragProps = (name: string) => {
    if (!onMove || stripUnits(items).length < 2) return {}
    return {
      'data-movable': true,
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (
          e.button !== 0 ||
          e.pointerType === 'touch' ||
          endDrag.current ||
          held.current ||
          regrouping.current ||
          moving
        )
          return
        startGroupDrag(name, e.clientX)
      },
    }
  }
  const startGroupDrag = (name: string, startX: number) => {
    const list = scrollRef.current!
    // Set when the drag starts: the units' elements and boxes (the first
    // element's left to the last one's right), the dragged one, and the
    // room it takes
    let els: HTMLElement[][] = []
    let boxes: Pick<DOMRect, 'left' | 'right' | 'width'>[] = []
    let from = -1
    let to = -1
    let room = 0
    const begin = () => {
      const shown = [...list.children].filter(
        (c): c is HTMLElement =>
          c instanceof HTMLElement && !c.hasAttribute('data-leaving'),
      )
      // The same units as the items: shown follows their order
      let i = 0
      const units = stripUnits(latest.current.items)
      els = units.map((u) => u.map(() => shown[i++]))
      boxes = els.map((u) => {
        const left = u[0].getBoundingClientRect().left
        const right = u.at(-1)!.getBoundingClientRect().right
        return { left, right, width: right - left }
      })
      from = units.findIndex(
        (u) => u[0].kind === 'group' && u[0].group.name === name,
      )
      to = from
      room =
        boxes[from].width +
        (Number.parseFloat(getComputedStyle(list).columnGap) || 0)
      for (const el of els[from]) el.setAttribute('data-dragging', 'true')
      if (list.contains(document.activeElement))
        (document.activeElement as HTMLElement).blur()
    }
    const slide = (unit: HTMLElement[], x: number) => {
      for (const el of unit) el.style.translate = x ? `${x}px 0` : ''
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
      slide(els[from], x)
      to = slidePlace(boxes, from, x)
      els.forEach((unit, i) => {
        if (i !== from) slide(unit, slideShift(i, from, to, room))
      })
    }
    const finish = (drop: boolean) => {
      window.removeEventListener('pointermove', onMoveEvent)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      endDrag.current = null
      if (from === -1) return
      for (const el of els[from]) el.removeAttribute('data-dragging')
      // The click that ends the drag does not fold the group
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true))
      const all = els.flat()
      const putBack = () => {
        for (const el of all) el.style.translate = ''
      }
      // The bar changed under the drag: its places no longer hold
      const now = stripUnits(latest.current.items)
      const lead = now[from]?.[0]
      const same =
        now.length === els.length &&
        lead?.kind === 'group' &&
        lead.group.name === name
      if (!drop || to === from || !same) return putBack()
      // Into its slot, the others still aside, until the new order
      slide(
        els[from],
        to > from
          ? boxes[to].right - boxes[from].right
          : boxes[to].left - boxes[from].left,
      )
      held.current = {
        tabs: all,
        timer: window.setTimeout(() => letGo.current(true), HOLD_MS),
      }
      latest.current.moveGroup(name, to)
    }
    const swallow = (c: MouseEvent) => {
      c.stopPropagation()
      c.preventDefault()
    }
    const onUp = () => finish(true)
    const onCancel = () => finish(false)
    // Escape puts the group back
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
                drag={leaving ? {} : groupDragProps(item.group.name)}
                group={item.group}
                leaving={leaving}
                entering={isNew(key)}
                buttonRef={(el) => {
                  if (leaving) return
                  if (el) groupButtons.current.set(item.group.name, el)
                  else groupButtons.current.delete(item.group.name)
                }}
                onToggle={() =>
                  toggleFold(item.group.name, !item.group.collapsed)
                }
                onMenu={() => openGroupMenu(item.group.name, false)}
                keys={[
                  'Shift+F10',
                  onMove && 'Alt+ArrowLeft Alt+ArrowRight',
                  canRename && 'F2',
                  onAdd && 'N',
                ]
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
              data-key={key}
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
              className={`group relative flex h-9 shrink-0 items-center pr-1.5 text-[13px] ${group === undefined ? '' : `after:pointer-events-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full ${tabGroupLine(group)}`} transition-[color,background-color,border-color,opacity,translate,scale] duration-(--duration-fast) ease-standard motion-safe:active:scale-[0.98] data-dragging:z-20 data-dragging:transition-none ${isNew(key) || (group !== undefined && folded.current) ? ENTER_FROM : ''} ${leaving ? LEAVE_TO : ''} ${
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
          // Another group asked for while open starts it again
          key={formGroup ?? '\0'}
          group={tabGroups ? formGroup : undefined}
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
          {(onMove || regroups) && (
            <>
              <MenuItem
                disabled={!stepPlan(menuSession.id, -1)}
                // i18n-ignore: a key's name
                shortcut={{ label: 'Alt+←', aria: 'Alt+ArrowLeft' }}
                onSelect={() => step(menuSession.id, -1)}
              >
                {t('shell.tabs.moveLeft')}
              </MenuItem>
              <MenuItem
                disabled={!stepPlan(menuSession.id, 1)}
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
              onSelect={() =>
                openForm(menuAnchor.current, groupOfTab(menuSession.id))
              }
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
            onSelect={() =>
              toggleFold(menuOfGroup.name, !menuOfGroup.collapsed)
            }
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
  // Its dragging (pointer down and data-movable), where groups move
  drag: object
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
  drag,
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
      data-key={`\0${group.name}`}
      inert={leaving}
      aria-hidden={leaving || undefined}
      data-leaving={leaving || undefined}
      {...(renaming ? {} : drag)}
      onContextMenu={(e) => {
        if (leaving || renaming) return
        e.preventDefault()
        onMenu()
      }}
      className={`mb-0.5 flex h-8 shrink-0 items-center px-0.5 transition-[opacity,translate,scale] duration-(--duration-fast) ease-standard data-dragging:z-20 data-dragging:transition-none pointer-coarse:h-10 ${entering ? ENTER_FROM : ''} ${leaving ? LEAVE_TO : ''}`}
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
              {/* A counter, apart from the name: a small pill */}
              <span
                data-group-count
                className="-mr-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-white/25 px-1 text-[10px] font-semibold leading-none tabular-nums"
              >
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
