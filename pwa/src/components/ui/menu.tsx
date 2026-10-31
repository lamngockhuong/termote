import { Check } from 'lucide-react'
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { useExitTransition } from '../../hooks/use-exit-transition'
import { FOCUS_RING, IconButton } from './button'

// The least room left between an open menu and the screen's edge, in px
const MENU_MARGIN = 8
// The gap between the trigger and the menu (mt-2), in px
const MENU_GAP = 8

// The top layer (Popover API) lifts the open menu out of every scrolling or
// transformed ancestor: a sidebar list no longer cuts it. Without it (jsdom,
// older browsers) the menu stays absolute under its trigger.
const topLayer = () =>
  typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype

// Where the menu goes in the viewport (position: fixed): under the trigger,
// aligned to its edge as before and kept on the screen; above it when there
// is not room below and more room above; capped in height, scrolling inside,
// when neither side holds it. The visible part of the viewport counts, so an
// open keyboard (visualViewport) is left out.
export function placeMenu(
  trigger: DOMRect,
  menu: { width: number; height: number },
  align: 'start' | 'end',
  view: { width: number; top: number; height: number },
) {
  const left = Math.max(
    MENU_MARGIN,
    Math.min(
      align === 'end' ? trigger.right - menu.width : trigger.left,
      view.width - MENU_MARGIN - menu.width,
    ),
  )
  const below = view.top + view.height - MENU_MARGIN - trigger.bottom - MENU_GAP
  const above = trigger.top - MENU_GAP - MENU_MARGIN - view.top
  if (menu.height <= below || below >= above)
    return {
      left,
      top: trigger.bottom + MENU_GAP,
      maxHeight: menu.height <= below ? undefined : below,
    }
  if (menu.height <= above)
    return {
      left,
      top: trigger.top - MENU_GAP - menu.height,
      maxHeight: undefined,
    }
  return { left, top: view.top + MENU_MARGIN, maxHeight: above }
}

// Closes the menu; byKey says an item was chosen with Enter or Space
const MenuContext = createContext<(byKey?: boolean) => void>(() => {})

interface MenuProps {
  // Accessible name of the trigger button
  label: string
  // Content of the trigger button (usually an icon)
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  className?: string
  // The trigger's tab order: -1 keeps it out of Tab (a row's own key opens
  // what it offers)
  triggerTabIndex?: number
  // The trigger's size (a tree row's is small)
  triggerSize?: 'sm' | 'md'
  // A trigger of text, styled by these classes, instead of an icon button
  textTrigger?: string
  // Opened and closed from outside as well (a long press on a tree row);
  // left out, the menu keeps its own state
  open?: boolean
  onOpenChange?: (open: boolean) => void
  // Names the menu for the tour (data-tour)
  tourAnchor?: string
}

// menuitem and menuitemradio
const ITEM_ROLES = '[role^="menuitem"]'

const items = (list: HTMLElement) => [
  ...list.querySelectorAll<HTMLElement>(`${ITEM_ROLES}:not([disabled])`),
]

// A popover menu anchored to its trigger. Arrow keys, Home and End move
// between items; Escape closes it and gives focus back to the trigger; focus
// or a tap moving outside closes it. Keys pressed in other content inside the
// menu are left to that content. A choice among options (the theme) belongs in
// a MenuGroup of MenuItemRadio, not in a radiogroup: role="menu" may only hold
// menu items, groups and separators.
export function Menu({
  label,
  trigger,
  children,
  align = 'end',
  className = '',
  triggerTabIndex,
  triggerSize,
  textTrigger,
  open,
  onOpenChange,
  tourAnchor,
}: MenuProps) {
  const [ownOpen, setOwnOpen] = useState(false)
  const isOpen = open ?? ownOpen
  const setIsOpen = (next: boolean) => {
    if (open === undefined) setOwnOpen(next)
    onOpenChange?.(next)
  }
  // For the listener below, which lives as long as the menu is open
  const setIsOpenRef = useRef(setIsOpen)
  setIsOpenRef.current = setIsOpen
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  // Opened by Enter/Space (a click with detail 0) rather than a pointer.
  const openedByKeyRef = useRef(false)
  // Whether the menu was open when a press on the trigger began. Where a tap
  // does not focus the trigger (Safari, iOS), the press blurs the menu box
  // with no relatedTarget and the blur closes the menu before the click, so
  // the click alone would open it again.
  const openAtPressRef = useRef<boolean | null>(null)
  // Closed, the menu stays for its fade out, inert
  const { mounted, closing } = useExitTransition(isOpen, listRef)

  // Focus goes back to the trigger with a ring only after a key: Safari
  // rings any focus() that follows a tap, and keeps it there once a sheet
  // the item opened gives focus back.
  const close = (byKey = true) => {
    setIsOpen(false)
    triggerRef.current?.focus({ focusVisible: byKey })
  }

  // Opened from the keyboard, focus the first item so the arrow keys work at
  // once. Opened by a tap or click, focus the menu box instead: focusing an
  // item there makes iOS draw a focus ring round it. The arrow keys still
  // work from the box.
  useEffect(() => {
    if (!isOpen) return
    // preventScroll: a menu in the top layer is already in view; scrolling
    // a list under it to "show" it would close it.
    if (openedByKeyRef.current)
      items(listRef.current!)[0]?.focus({ preventScroll: true })
    else listRef.current!.focus({ preventScroll: true })
  }, [isOpen])

  // In the top layer the menu is placed in the viewport (placeMenu). Else it
  // is kept on the screen: a trigger away from the edge it is aligned to (a
  // header with buttons after it) would push the menu past the other edge.
  // Measured before paint, so it never shows cut off first.
  const inTopLayer = topLayer()
  // offsetHeight: as tall as the menu shows, a max-h class included. Only
  // called while the menu is open, so both elements are there.
  const placeInViewport = () => {
    const list = listRef.current!
    const vv = window.visualViewport
    const at = placeMenu(
      triggerRef.current!.getBoundingClientRect(),
      { width: list.offsetWidth, height: list.offsetHeight },
      align,
      {
        width: document.documentElement.clientWidth,
        top: vv?.offsetTop ?? 0,
        height: vv?.height ?? window.innerHeight,
      },
    )
    list.style.left = `${at.left}px`
    list.style.top = `${at.top}px`
    list.style.maxHeight = at.maxHeight === undefined ? '' : `${at.maxHeight}px`
  }
  const placeRef = useRef(placeInViewport)
  placeRef.current = placeInViewport
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    if (!isOpen) return
    const list = listRef.current!
    if (inTopLayer) {
      list.showPopover()
      placeRef.current()
      return
    }
    const rect = list.getBoundingClientRect()
    if (rect.width === 0) return
    const edge = document.documentElement.clientWidth - MENU_MARGIN
    if (rect.left < MENU_MARGIN) setShift(MENU_MARGIN - rect.left)
    else if (rect.right > edge) setShift(edge - rect.right)
  }, [isOpen, inTopLayer])
  // Kept while it fades out, so it leaves from where it was
  useLayoutEffect(() => {
    if (!mounted) setShift(0)
  }, [mounted])
  // Out of the top layer as its fade starts; exit-discrete keeps it shown
  // until the fade ends
  useLayoutEffect(() => {
    if (closing && inTopLayer) listRef.current!.hidePopover()
  }, [closing, inTopLayer])

  // Placed in the viewport, the menu would drift off its trigger as a list
  // holding the trigger scrolls: that closes it. Any other scroll (a Chat
  // following new messages, a table under its own menu) and a scroll inside
  // the menu leave it; a resized window (a phone's keyboard closing) places
  // it again.
  useEffect(() => {
    if (!isOpen || !inTopLayer) return
    const onScroll = (e: Event) => {
      const target = e.target as Node
      if (listRef.current?.contains(target)) return
      const trigger = triggerRef.current
      if (trigger && (target === document || target.contains(trigger)))
        setIsOpenRef.current(false)
    }
    const onResize = () => placeRef.current()
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [isOpen, inTopLayer])

  // pointerdown, not mousedown: a touch that scrolls elsewhere sends no mouse events.
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node))
        setIsOpenRef.current(false)
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [isOpen])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    // Arrow keys belong to the item list, not to a control inside the menu.
    const onBox = e.target === listRef.current
    if (!onBox && !(e.target as HTMLElement).matches(ITEM_ROLES)) return
    const list = items(listRef.current!)
    if (list.length === 0) return
    // -1 on the box: ArrowDown goes to the first item, ArrowUp to the last.
    const at = list.indexOf(document.activeElement as HTMLElement)
    const next = {
      ArrowDown: (at + 1) % list.length,
      ArrowUp: ((at < 0 ? list.length : at) - 1 + list.length) % list.length,
      Home: 0,
      End: list.length - 1,
    }[e.key]
    if (next === undefined) return
    e.preventDefault()
    list[next].focus()
  }

  const triggerProps = {
    ref: triggerRef,
    tabIndex: triggerTabIndex,
    'aria-label': label,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': isOpen,
    'aria-controls': isOpen ? menuId : undefined,
    onPointerDown: () => {
      openAtPressRef.current = isOpen
    },
    onClick: (e: MouseEvent) => {
      openedByKeyRef.current = e.detail === 0
      // Enter/Space has no press: a ref left by a press that ended
      // elsewhere must not decide it.
      const wasOpen =
        e.detail !== 0 && openAtPressRef.current !== null
          ? openAtPressRef.current
          : isOpen
      openAtPressRef.current = null
      setIsOpen(!wasOpen)
    },
    children: trigger,
  }

  return (
    <div
      ref={rootRef}
      data-tour={tourAnchor}
      className="relative"
      // Tab (or anything else) moving focus out of the trigger and menu closes it.
      onBlur={(e) => {
        if (!rootRef.current!.contains(e.relatedTarget as Node | null))
          setIsOpen(false)
      }}
    >
      {textTrigger === undefined ? (
        <IconButton size={triggerSize} {...triggerProps} />
      ) : (
        <button
          type="button"
          className={`${FOCUS_RING} ${textTrigger}`}
          {...triggerProps}
        />
      )}
      {mounted && (
        <div
          ref={listRef}
          id={menuId}
          inert={closing}
          aria-hidden={closing || undefined}
          data-closing={closing || undefined}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          // manual: no light dismiss and no focus handling of its own; the
          // menu keeps doing both
          popover={inTopLayer ? 'manual' : undefined}
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          // In the top layer: fixed, placed by style; the UA's popover inset,
          // margin and padding reset so these classes decide the look
          className={`z-50 outline-none w-64 border border-border bg-surface-raised py-1 text-fg shadow-xl rounded-panel ui-native:border-0 exit-discrete duration-(--duration-fast) ease-standard starting:-translate-y-1 starting:opacity-0 ${closing ? 'pointer-events-none -translate-y-1 opacity-0' : ''} ${inTopLayer ? 'fixed inset-auto m-0 overflow-y-auto px-0' : `absolute top-full mt-2 ${align === 'end' ? 'right-0' : 'left-0'}`} ${className}`}
        >
          <MenuContext.Provider value={close}>{children}</MenuContext.Provider>
        </div>
      )}
    </div>
  )
}

interface MenuItemProps {
  // Without it the item only closes the menu: a disabled item that says why
  // something is not offered. Shift says whether it was held (a popup).
  onSelect?: (e: { shiftKey: boolean }) => void
  children: ReactNode
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  // Keep the menu open after the item runs (e.g. it shows progress itself)
  keepOpen?: boolean
  // Says more about what the item does, on hover
  title?: string
}

function ItemButton({
  onSelect,
  children,
  icon,
  danger = false,
  disabled = false,
  keepOpen = false,
  title,
  checked,
  checkbox = false,
}: MenuItemProps & { checked?: boolean; checkbox?: boolean }) {
  const close = useContext(MenuContext)
  const role =
    checked === undefined
      ? { role: 'menuitem' }
      : {
          role: checkbox ? 'menuitemcheckbox' : 'menuitemradio',
          'aria-checked': checked,
        }
  return (
    <button
      type="button"
      {...role}
      tabIndex={-1}
      disabled={disabled}
      title={title}
      onClick={(e) => {
        onSelect?.({ shiftKey: e.shiftKey })
        if (!keepOpen) close(e.detail === 0)
      }}
      className={`flex h-10 w-full items-center gap-3 px-3 text-left text-[14px] hover:bg-surface focus:bg-surface disabled:opacity-50 pointer-coarse:h-touch ui-terminal:font-label ui-terminal:text-[13px] ${FOCUS_RING} focus-visible:-outline-offset-2 ${danger ? 'text-danger' : 'text-fg'}`}
    >
      {icon && (
        <span
          aria-hidden="true"
          className={danger ? 'text-danger' : 'text-fg-muted'}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">{children}</span>
      {checked && (
        <Check size={16} aria-hidden="true" className="shrink-0 text-accent" />
      )}
    </button>
  )
}

export function MenuItem(props: MenuItemProps) {
  return <ItemButton {...props} />
}

// One choice of a MenuGroup (e.g. a theme); the checked one shows a tick.
export function MenuItemRadio(props: MenuItemProps & { checked: boolean }) {
  return <ItemButton {...props} />
}

// A setting turned on or off (e.g. Wrap lines); when on it shows a tick.
export function MenuItemCheckbox(props: MenuItemProps & { checked: boolean }) {
  return <ItemButton {...props} checkbox />
}

// Labelled set of items, e.g. the theme choices as MenuItemRadio.
export function MenuGroup({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  const labelId = useId()
  return (
    // A fieldset is a native group (role="group"), which a menu may hold.
    <fieldset aria-labelledby={labelId} className="m-0 min-w-0 border-0 p-0">
      <div
        id={labelId}
        className="px-3 pb-1 pt-2 text-[11px] uppercase tracking-wider text-fg-subtle font-label"
      >
        {label}
      </div>
      {children}
    </fieldset>
  )
}

export function MenuSeparator() {
  return <hr className="my-1 border-0 border-t border-border" />
}
