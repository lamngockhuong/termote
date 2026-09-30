import type { LucideIcon } from 'lucide-react'
import { type KeyboardEvent, useRef } from 'react'
import { FOCUS_RING } from './button'

export interface ViewOption<T extends string> {
  id: T
  label: string
  Icon: LucideIcon
}

interface Props<T extends string> {
  views: ViewOption<T>[]
  value: T
  onChange: (id: T) => void
  // Shows the label next to the icon (desktop header)
  showLabels?: boolean
  // Id of the role="tabpanel" element that shows a view (for aria-controls)
  panelId?: (id: T) => string
}

// Switches the pane between its views (terminal, and later chat, files).
// Renders nothing while only one view is available.
export function ViewSwitcher<T extends string>({
  views,
  value,
  onChange,
  showLabels = false,
  panelId,
}: Props<T>) {
  const listRef = useRef<HTMLDivElement>(null)
  if (views.length < 2) return null
  const current = Math.max(
    0,
    views.findIndex((v) => v.id === value),
  )

  const onKeyDown = (e: KeyboardEvent) => {
    const last = views.length - 1
    const next = {
      ArrowRight: current === last ? 0 : current + 1,
      ArrowLeft: current === 0 ? last : current - 1,
      Home: 0,
      End: last,
    }[e.key]
    if (next === undefined) return
    e.preventDefault()
    onChange(views[next].id)
    listRef.current
      ?.querySelectorAll<HTMLElement>('[role="tab"]')
      [next]?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="View"
      onKeyDown={onKeyDown}
      className="flex shrink-0 gap-0.5 border border-border bg-surface p-0.5 rounded-control ui-native:rounded-full ui-native:border-0"
    >
      {views.map(({ id, label, Icon }, i) => {
        const selected = i === current
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId?.(id)}
            aria-label={showLabels ? undefined : label}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            className={`flex items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] ui-native:rounded-full ${FOCUS_RING} ${showLabels ? 'h-7 px-2.5 text-[12px] pointer-coarse:h-touch' : 'size-9 pointer-coarse:size-touch'} ${
              selected
                ? 'bg-surface-raised text-fg shadow-sm ui-terminal:bg-accent-soft ui-terminal:text-accent ui-terminal:shadow-none'
                : 'text-fg-muted hover:text-fg'
            }`}
          >
            <Icon size={showLabels ? 14 : 17} aria-hidden="true" />
            {showLabels && (
              <span className="ui-terminal:font-label">{label}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
