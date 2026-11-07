import type { LucideIcon } from 'lucide-react'
import { type KeyboardEvent, useRef } from 'react'
import { COMPACT_LABEL_ATTR } from '../../hooks/use-compact-labels'
import { useT } from '../../i18n/i18n-context'
import { FOCUS_RING } from './button'

export interface ViewOption<T extends string> {
  id: T
  label: string
  Icon: LucideIcon
}

// A view or panel button's label: read out always, shown once the header
// (an @container) is at least 60rem wide and its tabs have room (compact
// off); otherwise the buttons show their icon only and name it in the tooltip
export const headerLabel = (compact: boolean) =>
  compact ? 'sr-only' : 'sr-only @[60rem]:not-sr-only'

// Marks a label for useCompactLabels, which measures the shown ones
export const LABEL_PROPS = { [COMPACT_LABEL_ATTR]: '' }

export type Orientation = 'horizontal' | 'vertical'

// The group and its buttons in a row (the header) or a column (the right
// bar, where a button is a square showing its icon only, 44px on a touch
// screen). In a row the hit area reaches above and below the button; in a
// column it stays on the button, or it would take the next one's edge.
export const GROUP_CLASS: Record<Orientation, string> = {
  horizontal: 'flex shrink-0',
  vertical: 'flex shrink-0 flex-col',
}
export const BUTTON_SIZE: Record<Orientation, string> = {
  horizontal:
    'h-7 px-2.5 pointer-coarse:h-9 before:inset-x-0 before:-inset-y-1',
  vertical: 'size-8 pointer-coarse:size-touch before:inset-0',
}

interface Props<T extends string> {
  views: ViewOption<T>[]
  value: T
  onChange: (id: T) => void
  // Id of the role="tabpanel" element that shows a view (for aria-controls)
  panelId?: (id: T) => string
  // The header's tabs need the room: icons only
  compact?: boolean
  // vertical: on the right bar, icons only, Up and Down move between views
  orientation?: Orientation
}

// Desktop header tabs switching the pane between its views (terminal, chat,
// ...); the mobile header uses ViewMenu. Renders nothing while only one view
// is available. On a touch screen a button is 36px, its group level with the
// session tabs, and a pseudo-element grows its hit area to 44px.
export function ViewSwitcher<T extends string>({
  views,
  value,
  onChange,
  panelId,
  compact = false,
  orientation = 'horizontal',
}: Props<T>) {
  const vertical = orientation === 'vertical'
  const { t } = useT()
  const listRef = useRef<HTMLDivElement>(null)
  if (views.length < 2) return null
  const current = Math.max(
    0,
    views.findIndex((v) => v.id === value),
  )

  const onKeyDown = (e: KeyboardEvent) => {
    const last = views.length - 1
    const forward = current === last ? 0 : current + 1
    const back = current === 0 ? last : current - 1
    const next = {
      [vertical ? 'ArrowDown' : 'ArrowRight']: forward,
      [vertical ? 'ArrowUp' : 'ArrowLeft']: back,
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
      data-tour="view-switcher"
      role="tablist"
      aria-label={t('shell.view')}
      aria-orientation={vertical ? 'vertical' : undefined}
      onKeyDown={onKeyDown}
      className={`${GROUP_CLASS[orientation]} gap-0.5 border border-border bg-surface p-0.5 rounded-control ui-native:rounded-full ui-native:border-0`}
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
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            title={label}
            className={`relative before:absolute before:content-[''] flex items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] ui-native:rounded-full ${FOCUS_RING} ${BUTTON_SIZE[orientation]} text-[12px] ${
              selected
                ? 'bg-surface-raised text-fg shadow-sm ui-terminal:bg-accent-soft ui-terminal:text-accent ui-terminal:shadow-none'
                : 'text-fg-muted hover:text-fg'
            }`}
          >
            <Icon size={14} aria-hidden="true" />
            <span
              {...LABEL_PROPS}
              className={`ui-terminal:font-label ${headerLabel(compact || vertical)}`}
            >
              {label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
