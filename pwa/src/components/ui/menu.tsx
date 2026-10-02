import { Check } from 'lucide-react'
import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { FOCUS_RING, IconButton } from './button'

const MenuContext = createContext<() => void>(() => {})

interface MenuProps {
  // Accessible name of the trigger button
  label: string
  // Content of the trigger button (usually an icon)
  trigger: ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  className?: string
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
}: MenuProps) {
  const [isOpen, setIsOpen] = useState(false)
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

  const close = () => {
    setIsOpen(false)
    triggerRef.current?.focus()
  }

  // Opened from the keyboard, focus the first item so the arrow keys work at
  // once. Opened by a tap or click, focus the menu box instead: focusing an
  // item there makes iOS draw a focus ring round it. The arrow keys still
  // work from the box.
  useEffect(() => {
    if (!isOpen) return
    if (openedByKeyRef.current) items(listRef.current!)[0]?.focus()
    else listRef.current!.focus()
  }, [isOpen])

  // pointerdown, not mousedown: a touch that scrolls elsewhere sends no mouse events.
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setIsOpen(false)
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

  return (
    <div
      ref={rootRef}
      className="relative"
      // Tab (or anything else) moving focus out of the trigger and menu closes it.
      onBlur={(e) => {
        if (!rootRef.current!.contains(e.relatedTarget as Node | null))
          setIsOpen(false)
      }}
    >
      <IconButton
        ref={triggerRef}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        onPointerDown={() => {
          openAtPressRef.current = isOpen
        }}
        onClick={(e) => {
          openedByKeyRef.current = e.detail === 0
          // Enter/Space has no press: a ref left by a press that ended
          // elsewhere must not decide it.
          const wasOpen =
            e.detail !== 0 && openAtPressRef.current !== null
              ? openAtPressRef.current
              : isOpen
          openAtPressRef.current = null
          setIsOpen(!wasOpen)
        }}
      >
        {trigger}
      </IconButton>
      {isOpen && (
        <div
          ref={listRef}
          id={menuId}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className={`absolute top-full z-50 mt-2 outline-none w-64 border border-border bg-surface-raised py-1 text-fg shadow-xl rounded-panel ui-native:border-0 transition-[opacity,translate] duration-(--duration-fast) ease-standard starting:-translate-y-1 starting:opacity-0 ${align === 'end' ? 'right-0' : 'left-0'} ${className}`}
        >
          <MenuContext.Provider value={close}>{children}</MenuContext.Provider>
        </div>
      )}
    </div>
  )
}

interface MenuItemProps {
  onSelect: () => void
  children: ReactNode
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  // Keep the menu open after the item runs (e.g. it shows progress itself)
  keepOpen?: boolean
}

function ItemButton({
  onSelect,
  children,
  icon,
  danger = false,
  disabled = false,
  keepOpen = false,
  checked,
}: MenuItemProps & { checked?: boolean }) {
  const close = useContext(MenuContext)
  const role =
    checked === undefined
      ? { role: 'menuitem' }
      : { role: 'menuitemradio', 'aria-checked': checked }
  return (
    <button
      type="button"
      {...role}
      tabIndex={-1}
      disabled={disabled}
      onClick={() => {
        onSelect()
        if (!keepOpen) close()
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
