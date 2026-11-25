import { type KeyboardEvent, useRef } from 'react'
import { FOCUS_RING } from './ui/button'

export type OverviewTab = 'agents' | 'plan'

export interface OverviewTabDef {
  id: OverviewTab
  // The label with its count: "Agents · 5", "Plan · 2 open"
  label: string
  // A count in red, only when there is something to answer ("1 needs you")
  alert?: string
  // What a screen reader calls the tab, the counts included
  name: string
}

interface Props {
  // The tablist's name
  label: string
  tabs: readonly OverviewTabDef[]
  value: OverviewTab
  onChange: (tab: OverviewTab) => void
  // The ids of a tab and its panel derive from it
  idPrefix: string
}

// The tab this browser looked at last; a convenience of this browser only,
// so Agents without storage
const TAB_KEY = 'termote-overview-tab'

export function readOverviewTab(): OverviewTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'plan' ? 'plan' : 'agents'
  } catch {
    return 'agents'
  }
}

export function writeOverviewTab(tab: OverviewTab) {
  try {
    localStorage.setItem(TAB_KEY, tab)
  } catch {
    // Storage unavailable: Agents next time
  }
}

export const overviewTabId = (prefix: string, tab: OverviewTab) =>
  `${prefix}-tab-${tab}`
export const overviewPanelId = (prefix: string, tab: OverviewTab) =>
  `${prefix}-panel-${tab}`

// The overview's sections as tabs whose words always show, each with its
// counts. Arrows, Home and End move to another tab and select it; only the
// selected tab is in the Tab order.
export function OverviewTabs({
  label,
  tabs,
  value,
  onChange,
  idPrefix,
}: Props) {
  const refs = useRef(new Map<OverviewTab, HTMLButtonElement>())
  const move = (e: KeyboardEvent, from: number) => {
    const last = tabs.length - 1
    const to =
      e.key === 'ArrowRight'
        ? from === last
          ? 0
          : from + 1
        : e.key === 'ArrowLeft'
          ? from === 0
            ? last
            : from - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : -1
    if (to === -1) return
    e.preventDefault()
    const tab = tabs[to].id
    onChange(tab)
    refs.current.get(tab)?.focus()
  }
  return (
    // A segmented track: on a phone the two tabs share the row's width
    <div
      role="tablist"
      aria-label={label}
      className="grid min-w-0 grid-cols-2 gap-0.5 rounded-control bg-surface p-0.5 sm:inline-flex ui-terminal:bg-bg"
    >
      {tabs.map((tab, i) => {
        const selected = tab.id === value
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) refs.current.set(tab.id, el)
              else refs.current.delete(tab.id)
            }}
            type="button"
            role="tab"
            id={overviewTabId(idPrefix, tab.id)}
            aria-selected={selected}
            aria-controls={overviewPanelId(idPrefix, tab.id)}
            aria-label={tab.name}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => move(e, i)}
            className={`flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] px-3 text-[13px] tabular-nums transition-colors duration-(--duration-fast) ease-standard pointer-coarse:h-9 ${
              selected
                ? 'bg-surface-raised font-semibold text-fg shadow-sm ui-terminal:bg-accent-soft ui-terminal:text-accent-text ui-terminal:shadow-none'
                : 'font-medium text-fg-muted hover:text-fg'
            } ${FOCUS_RING}`}
          >
            <span className="truncate">{tab.label}</span>
            {tab.alert && (
              <span className="shrink-0 rounded-full bg-danger/15 px-1.5 text-[11px] font-medium tabular-nums text-danger">
                {tab.alert}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
