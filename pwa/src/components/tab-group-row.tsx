import { Plus } from 'lucide-react'
import { type KeyboardEvent, useRef, useState } from 'react'
import { useWheelScrollX } from '../hooks/use-wheel-scroll-x'
import { useT } from '../i18n/i18n-context'
import { type TabGroupRow, tabGroupFill } from '../utils/tab-group'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { AgentStatusBadge } from './agent-status-badge'
import { NewTabForm } from './new-tab-form'
import { FOCUS_RING, IconButton } from './ui/button'

interface Props {
  rows: TabGroupRow[]
  // The group of the tab on screen; unset: the tabs in none
  active?: string
  onSelect: (row: TabGroupRow) => void
  // Unset (view-only role): no New tab group button. name: the tab's whole
  // name, its group first
  onAdd?: (name: string, icon?: string) => void
}

// The tab groups of the workspace on screen in a row of the header's whole
// width above its tab bar (the row layout, setting tabGroupsLayout), which
// then shows the picked one's tabs only. Each shows its colour, how many
// tabs it has and the heaviest agent status among them. Arrow keys move the
// focus; Enter or Space picks, since a pick switches the tab on screen. +
// asks for a new group and its first tab.
export function TabGroupRows({ rows, active, onSelect, onAdd }: Props) {
  const { t } = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  useWheelScrollX(scrollRef)
  const addRef = useRef<HTMLButtonElement>(null)
  const [formOpen, setFormOpen] = useState(false)
  const closeForm = (byPress = false) => {
    setFormOpen(false)
    if (!byPress) addRef.current!.focus()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const tabs = [
      ...scrollRef.current!.querySelectorAll<HTMLElement>('[role="tab"]'),
    ]
    const at = tabs.indexOf(document.activeElement as HTMLElement)
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

  return (
    <div className="relative flex w-full min-w-0 shrink-0 items-center gap-1 pt-1">
      <div
        ref={scrollRef}
        role="tablist"
        aria-label={t('shell.tabGroups.row')}
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-hide"
      >
        {rows.map((row) => {
          const selected = row.name === active
          const name =
            row.name === undefined
              ? t('shell.tabGroups.none')
              : visibleUnsafe(row.name)
          // A group is drawn in its colour once picked, as in the tab bar
          const fill =
            row.name === undefined
              ? 'bg-term text-fg shadow-sm'
              : `${tabGroupFill(row.name)} text-white`
          return (
            <button
              key={row.name ?? ''}
              type="button"
              role="tab"
              data-tab-group-row={row.name ?? ''}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(row)}
              title={`${name} · ${t('shell.chip.sessions', { count: row.sessions.length })}`}
              className={`flex h-6 shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] font-medium transition-colors duration-(--duration-fast) ease-standard pointer-coarse:h-8 ${FOCUS_RING} ${
                selected
                  ? fill
                  : 'text-fg-muted hover:bg-surface-raised hover:text-fg'
              }`}
            >
              {row.name !== undefined && !selected && (
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${tabGroupFill(row.name)}`}
                />
              )}
              <span className="max-w-[160px] truncate ui-terminal:font-label">
                {name}
              </span>
              <span className="text-[11px] opacity-70">
                {row.sessions.length}
              </span>
              <AgentStatusBadge status={row.agentStatus} size={11} />
            </button>
          )
        })}
      </div>
      {onAdd && (
        <IconButton
          ref={addRef}
          size="sm"
          // Not a press outside the form: + itself closes it
          data-new-tab-group-toggle
          onClick={() => (formOpen ? closeForm() : setFormOpen(true))}
          aria-expanded={formOpen}
          className="size-6 pointer-coarse:size-8"
          aria-label={t('shell.tabGroups.add')}
          title={t('shell.tabGroups.add')}
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      )}
      {formOpen && (
        <NewTabForm
          onAdd={onAdd!}
          onClose={closeForm}
          toggleSelector="[data-new-tab-group-toggle]"
          groups={rows.flatMap((r) => r.name ?? [])}
          focusGroup
          align="start"
        />
      )}
    </div>
  )
}
