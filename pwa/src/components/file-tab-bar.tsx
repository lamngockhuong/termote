import { FolderTree, X } from 'lucide-react'
import {
  type KeyboardEvent,
  type PointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'
import { useLongPress } from '../hooks/use-long-press'
import { useWheelScrollX } from '../hooks/use-wheel-scroll-x'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { slidePlace, slideShift, targetIndex } from '../utils/reorder'
import { FOCUS_RING } from './ui/button'
import { Menu } from './ui/menu'

// A tab as the tab bar and the open-files sheet show it
export interface TabEntry {
  id: string
  // The file's name, and its whole path (the tooltip)
  name: string
  title: string
  // Shown under the name in the sheet: the file's directory
  detail?: string
  // Not pinned: the preview tab, replaced by the next file opened
  pinned: boolean
  // Has unsaved changes
  dirty: boolean
  // Its file was not found when last read (deleted or renamed elsewhere)
  missing?: boolean
}

// The tooltip of tab t: its path, and why it is struck through
export const tabTitle = (tab: TabEntry, t: Translate<MessageKey>) =>
  tab.missing ? t('files.tabs.missingTitle', { path: tab.title }) : tab.title

// What the tab bar (desktop) and the open-files sheet (mobile) both take
export interface TabListProps {
  tabs: TabEntry[]
  // null: the list (tree, changes) is shown
  activeId: string | null
  // The list's own entry, first: "Files", "Changes"
  homeLabel: string
  onActivate: (id: string | null) => void
  // Asks first when the tab has unsaved changes
  onClose: (id: string) => void
  onPin: (id: string) => void
  // Moves tab id to index to among the tabs (desktop: dragged, or
  // Alt+Left/Right); unset, tabs do not move
  onMove?: (id: string, to: number) => void
  // The element showing the tab (desktop): each tab controls it, and its
  // id names it
  panelId?: string
}

// The id of tab id's element (null: the list's entry), under panelId
export const tabElementId = (panelId: string, id: string | null) =>
  `${panelId}-tab-${id ?? 'list'}`

// How far (px) a pressed tab moves before it drags
const DRAG_SLOP = 4

// Shift+F10 or the context menu key: the focused tab's menu
const menuKey = (e: KeyboardEvent) =>
  e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)

// The tab menu open: at the pointer (a right click) or by the tab (point
// null: a long press, the menu key). Kept once closed, so it fades out.
interface TabMenu {
  id: string
  point: { x: number; y: number } | null
  byKey: boolean
  open: boolean
}

const TAB = `flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-[12px] ${FOCUS_RING} focus-visible:-outline-offset-2`

// The open files above the viewer (desktop): the list's entry first, then a
// tab per file. Arrow keys, Home and End move between tabs, Enter or Space
// shows one, Delete closes it; a middle click closes, a double click pins.
// With onMove a tab drags along the row (a mouse or a pen), the others
// making room for it, and Alt+Left/Right moves the focused one. With
// menuFor a right click, a long press, Shift+F10 or the menu key opens a
// file tab's menu (never the list's entry).
export function FileTabBar({
  tabs,
  activeId,
  homeLabel,
  onActivate,
  onClose,
  onPin,
  onMove,
  panelId,
  menuFor,
}: TabListProps & {
  // The items of tab id's menu, built when it opens
  menuFor?: (id: string) => ReactNode
}) {
  const tabIds = (id: string | null) =>
    panelId ? { id: tabElementId(panelId, id), 'aria-controls': panelId } : {}
  const { t } = useT()
  const items = useRef(new Map<string | null, HTMLElement>())
  const barRef = useRef<HTMLDivElement>(null)
  useWheelScrollX(barRef)
  const ids: (string | null)[] = [null, ...tabs.map((tab) => tab.id)]
  // Ends a drag in progress (its window listeners), also on unmount
  const endDrag = useRef<(() => void) | null>(null)
  // What a drag reads when it lands: the tabs can change meanwhile
  const latest = useRef({ tabs, onMove })
  latest.current = { tabs, onMove }
  useEffect(() => () => endDrag.current?.(), [])

  const [menu, setMenu] = useState<TabMenu>()
  // The tab the menu hangs from and gives the focus back to
  const menuAnchor = useRef<HTMLElement | null>(null)
  const openMenu = (id: string, point: TabMenu['point'], byKey = false) => {
    // A tab opens its menu only while it is drawn
    menuAnchor.current = items.current.get(id) as HTMLElement
    setMenu({ id, point, byKey, open: true })
  }
  // The tab a finger rests on: a long press opens its menu
  const pressed = useRef<string>(undefined)
  const press = useLongPress(
    () => openMenu(pressed.current as string, null),
    (e: ReactMouseEvent) => {
      e.preventDefault()
      openMenu((e.currentTarget as HTMLElement).dataset.tab as string, {
        x: e.clientX,
        y: e.clientY,
      })
    },
  )

  // The tab shown stays in view as the bar scrolls sideways
  useEffect(() => {
    items.current
      .get(activeId)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const onKeyDown = (e: KeyboardEvent, id: string | null) => {
    if (menuFor && id !== null && menuKey(e)) {
      e.preventDefault()
      openMenu(id, null, true)
      return
    }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (id === null || !onMove) return
      // Alt+Left would also go back a page
      e.preventDefault()
      const files = tabs.map((tab) => tab.id)
      const to = targetIndex(files, id, e.key === 'ArrowLeft' ? -1 : 1)
      if (to !== null) onMove(id, to)
      return
    }
    const at = ids.indexOf(id)
    let next: string | null | undefined
    switch (e.key) {
      case 'ArrowRight':
        next = ids[(at + 1) % ids.length]
        break
      case 'ArrowLeft':
        next = ids[(at - 1 + ids.length) % ids.length]
        break
      case 'Home':
        next = ids[0]
        break
      case 'End':
        next = ids[ids.length - 1]
        break
      case 'Enter':
      case ' ':
        onActivate(id)
        break
      case 'Delete':
        if (id === null) return
        onClose(id)
        break
      default:
        return
    }
    e.preventDefault()
    if (next !== undefined) items.current.get(next)?.focus()
  }

  const ref = (id: string | null) => (el: HTMLElement | null) => {
    if (el) items.current.set(id, el)
    else items.current.delete(id)
  }
  // Dragging, like a browser's tabs: the tab slides along the files' part
  // of the row only, and the others slide aside to make room where it would
  // land. A press that moves less than DRAG_SLOP is still a click; touch
  // scrolls the row instead.
  const movable = !!onMove && tabs.length > 1
  const onPointerDown = (e: PointerEvent<HTMLElement>, id: string) => {
    if (
      !movable ||
      e.button !== 0 ||
      e.pointerType === 'touch' ||
      endDrag.current
    )
      return
    // The close button closes; it does not drag
    if ((e.target as HTMLElement).closest('button:not([role="tab"])')) return
    startDrag(id, e.currentTarget, e.clientX)
  }
  const startDrag = (id: string, el: HTMLElement, startX: number) => {
    const bar = barRef.current!
    // Set when the drag starts: the file tabs, their boxes without any
    // slide, and the room the dragged one takes
    let els: HTMLElement[] = []
    let boxes: DOMRect[] = []
    let from = -1
    let to = -1
    const begin = () => {
      els = [...bar.children].filter(
        (c): c is HTMLElement =>
          c instanceof HTMLElement && c.hasAttribute('data-tab'),
      )
      boxes = els.map((c) => c.getBoundingClientRect())
      from = els.indexOf(el)
      to = from
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
      const self = boxes[from]
      const x = Math.min(
        Math.max(dx, boxes[0].left - self.left),
        bar.getBoundingClientRect().right - self.right,
      )
      el.style.translate = `${x}px 0`
      to = slidePlace(boxes, from, x)
      els.forEach((c, i) => {
        if (i === from) return
        const shift = slideShift(i, from, to, self.width)
        c.style.translate = shift ? `${shift}px 0` : ''
      })
    }
    const finish = (drop: boolean) => {
      window.removeEventListener('pointermove', onMoveEvent)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
      endDrag.current = null
      if (from === -1) {
        el.removeAttribute('data-dragging')
        return
      }
      // The click that ends a drag (fired in the same task as the release,
      // when it is over the tab) does not show the tab
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, true))
      const { tabs: now, onMove: move } = latest.current
      // The tabs changed under the drag: their places no longer hold
      const same = now.length === els.length && now[from]?.id === id
      if (!drop || to === from || !same || !move) {
        // Back to their places, sliding
        el.removeAttribute('data-dragging')
        for (const c of els) c.style.translate = ''
        return
      }
      // Into the new order at once: the tabs' slides go in the same frame
      // as the order changes, none sliding from where it was drawn
      for (const c of els) {
        c.style.transition = 'none'
        c.style.translate = ''
      }
      el.removeAttribute('data-dragging')
      flushSync(() => move(id, to))
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          for (const c of els) c.style.transition = ''
        }),
      )
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

  // Keyboard focus stays on the tab shown (else the list's entry)
  const tabbable = ids.includes(activeId) ? activeId : null

  const menuTab = menu && tabs.find((tab) => tab.id === menu.id)
  return (
    <>
      <div
        ref={barRef}
        role="tablist"
        aria-label={t('files.tabs.open')}
        className="flex shrink-0 overflow-x-auto scrollbar-hide border-b border-border bg-surface ui-terminal:bg-bg"
      >
        <button
          ref={ref(null)}
          type="button"
          role="tab"
          {...tabIds(null)}
          aria-selected={activeId === null}
          tabIndex={tabbable === null ? 0 : -1}
          onClick={() => onActivate(null)}
          onKeyDown={(e) => onKeyDown(e, null)}
          className={`${TAB} border-r border-border ${activeId === null ? 'bg-bg text-fg' : 'text-fg-muted hover:text-fg'}`}
        >
          <FolderTree size={14} aria-hidden="true" />
          {homeLabel}
        </button>
        {tabs.map((tab) => {
          const shown = tab.id === activeId
          return (
            <div
              key={tab.id}
              role="presentation"
              data-tab={tab.id}
              // The tab the open menu acts on stays marked
              data-menu-open={(menu?.open && menu.id === tab.id) || undefined}
              {...(menuFor && press)}
              onPointerDown={(e) => {
                pressed.current = tab.id
                if (menuFor) press.onPointerDown(e)
                onPointerDown(e, tab.id)
              }}
              className={`group relative flex shrink-0 items-center border-r border-border data-dragging:z-10 data-dragging:bg-surface-raised data-dragging:text-fg data-dragging:shadow-sm data-menu-open:bg-accent/15 ${movable ? 'transition-[translate] duration-(--duration-fast) ease-standard data-dragging:transition-none' : ''} ${shown ? 'bg-bg text-fg' : 'text-fg-muted hover:text-fg'}`}
            >
              <button
                ref={ref(tab.id)}
                type="button"
                role="tab"
                {...tabIds(tab.id)}
                aria-selected={shown}
                aria-keyshortcuts={[
                  'Delete',
                  movable && 'Alt+ArrowLeft Alt+ArrowRight',
                  menuFor && 'Shift+F10',
                ]
                  .filter(Boolean)
                  .join(' ')}
                tabIndex={tabbable === tab.id ? 0 : -1}
                title={tabTitle(tab, t)}
                onClick={() => onActivate(tab.id)}
                onDoubleClick={() => onPin(tab.id)}
                // No autoscroll: a middle click closes the tab
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault()
                }}
                onAuxClick={(e) => {
                  if (e.button !== 1) return
                  e.preventDefault()
                  onClose(tab.id)
                }}
                onKeyDown={(e) => onKeyDown(e, tab.id)}
                className={`${TAB} max-w-48 pr-1`}
              >
                <span
                  className={`truncate ${tab.pinned ? '' : 'italic'} ${tab.missing ? 'text-fg-subtle line-through' : ''}`}
                >
                  {tab.name}
                </span>
                {!tab.pinned && (
                  <span className="sr-only"> {t('files.tabs.preview')}</span>
                )}
                {tab.missing && (
                  <span className="sr-only"> {t('files.tabs.notFound')}</span>
                )}
                {tab.dirty && (
                  <>
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full bg-accent"
                    />
                    <span className="sr-only"> {t('files.tabs.unsaved')}</span>
                  </>
                )}
              </button>
              <button
                type="button"
                // For the mouse: a tablist holds only tabs, and the tab's
                // Delete key closes it from the keyboard
                tabIndex={-1}
                aria-hidden="true"
                aria-label={t('files.tabs.closeName', { name: tab.name })}
                title={t('common.close')}
                onClick={() => onClose(tab.id)}
                className={`mr-1 flex size-5 shrink-0 items-center justify-center rounded-control hover:bg-surface ${FOCUS_RING} ${shown ? '' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'}`}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
      {menuFor && (
        <Menu
          label={t('files.tree.actions', { name: menuTab?.name ?? '' })}
          trigger={null}
          anchorRef={menuAnchor}
          align="start"
          open={!!menuTab && (menu as TabMenu).open}
          onOpenChange={(open) => setMenu((m) => m && { ...m, open })}
          point={menu?.point}
          focusFirst={menu?.byKey}
        >
          {menuTab && menuFor(menuTab.id)}
        </Menu>
      )}
    </>
  )
}
