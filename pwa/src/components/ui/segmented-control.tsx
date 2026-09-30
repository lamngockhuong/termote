import { type KeyboardEvent, type ReactNode, useRef } from 'react'
import { FOCUS_RING } from './button'

export interface SegmentOption<T extends string> {
  value: T
  // Visible content; an icon-only option needs `label` for its name
  content: ReactNode
  label?: string
}

interface Props<T extends string> {
  label: string
  options: SegmentOption<T>[]
  value: T
  onChange: (value: T) => void
  className?: string
}

// A radio group drawn as a segmented button row. One tab stop for the group
// (roving tabindex); arrow keys, Home and End select and move focus.
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  className = '',
}: Props<T>) {
  const groupRef = useRef<HTMLDivElement>(null)
  const current = options.findIndex((o) => o.value === value)

  const onKeyDown = (e: KeyboardEvent) => {
    const last = options.length - 1
    const next = {
      ArrowRight: current >= last ? 0 : current + 1,
      ArrowDown: current >= last ? 0 : current + 1,
      ArrowLeft: current <= 0 ? last : current - 1,
      ArrowUp: current <= 0 ? last : current - 1,
      Home: 0,
      End: last,
    }[e.key]
    if (next === undefined) return
    e.preventDefault()
    onChange(options[next].value)
    groupRef.current
      ?.querySelectorAll<HTMLElement>('[role="radio"]')
      [next]?.focus()
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={`inline-flex gap-0.5 border border-border bg-bg p-0.5 rounded-control ui-native:border-0 ui-native:bg-surface dark:ui-native:bg-bg ${className}`}
    >
      {options.map((o, i) => {
        const selected = i === current
        return (
          // A native radio cannot hold an icon and look like a segment button.
          // biome-ignore lint/a11y/useSemanticElements: button with role=radio, as the WAI-ARIA radio group pattern
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.label}
            // With no match (an unknown value) the first option keeps the tab stop
            tabIndex={selected || (current === -1 && i === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`flex h-8 min-w-9 items-center justify-center px-2 text-[13px] rounded-[calc(var(--radius-control)-2px)] pointer-coarse:h-10 ui-terminal:font-label ${FOCUS_RING} ${
              selected
                ? 'bg-surface-raised text-fg shadow-sm ui-terminal:bg-accent-soft ui-terminal:text-accent ui-terminal:shadow-none'
                : 'text-fg-muted hover:text-fg'
            }`}
          >
            {o.content}
          </button>
        )
      })}
    </div>
  )
}
