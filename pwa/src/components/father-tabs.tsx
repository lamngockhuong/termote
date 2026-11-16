import { Plus } from 'lucide-react'
import { type KeyboardEvent, useRef, useState } from 'react'
import { useWheelScrollX } from '../hooks/use-wheel-scroll-x'
import { useT } from '../i18n/i18n-context'
import type { FatherTab } from '../utils/father-tab'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { AgentStatusBadge } from './agent-status-badge'
import { NewTabForm } from './new-tab-form'
import { FOCUS_RING, IconButton } from './ui/button'

interface Props {
  fathers: FatherTab[]
  // The FatherTab of the tab on screen; unset: that of the tabs in none
  active?: string
  onSelect: (father: FatherTab) => void
  // Unset (view-only role): no New FatherTab button. name: the tab's whole
  // name, its FatherTab first
  onAdd?: (name: string, icon?: string) => void
}

// What a dragged tab can be dropped on: a FatherTab of the row, which
// data-father names ("": the tabs in none)
export const FATHER_TAB_DROP = '[data-father]'

// The FatherTabs of the workspace on screen, in a row of the header's whole
// width above its tab bar,
// which then shows the picked one's tabs only. Each shows how many tabs it
// has and the heaviest agent status among them. Arrow keys move the focus;
// Enter or Space picks, since a pick switches the tab on screen. A tab
// dragged from the tab bar can be dropped on one (FATHER_TAB_DROP). + asks
// for a new FatherTab and its first tab.
export function FatherTabs({ fathers, active, onSelect, onAdd }: Props) {
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
        aria-label={t('shell.fatherTabs.label')}
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-hide"
      >
        {fathers.map((father) => {
          const selected = father.name === active
          const name =
            father.name === undefined
              ? t('shell.fatherTabs.other')
              : visibleUnsafe(father.name)
          return (
            <button
              key={father.name ?? ''}
              type="button"
              role="tab"
              data-father={father.name ?? ''}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(father)}
              title={`${name} · ${t('shell.chip.sessions', { count: father.sessions.length })}`}
              className={`flex h-6 shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-control px-2 text-[12px] transition-colors duration-(--duration-fast) ease-standard pointer-coarse:h-8 data-drop-target:bg-surface-raised data-drop-target:text-fg data-drop-target:ring-2 data-drop-target:ring-accent data-drop-target:ring-inset ${FOCUS_RING} ${
                selected
                  ? 'bg-term font-medium text-fg shadow-sm'
                  : 'text-fg-muted hover:bg-surface-raised hover:text-fg'
              }`}
            >
              <span className="max-w-[160px] truncate ui-terminal:font-label">
                {name}
              </span>
              <span className="text-[11px] text-fg-subtle">
                {father.sessions.length}
              </span>
              <AgentStatusBadge status={father.agentStatus} size={11} />
            </button>
          )
        })}
      </div>
      {onAdd && (
        <IconButton
          ref={addRef}
          size="sm"
          // Not a press outside the form: + itself closes it
          data-new-father-toggle
          onClick={() => (formOpen ? closeForm() : setFormOpen(true))}
          aria-expanded={formOpen}
          className="size-6 pointer-coarse:size-8"
          aria-label={t('shell.fatherTabs.add')}
          title={t('shell.fatherTabs.add')}
        >
          <Plus size={14} aria-hidden="true" />
        </IconButton>
      )}
      {formOpen && (
        <NewTabForm
          onAdd={onAdd!}
          onClose={closeForm}
          toggleSelector="[data-new-father-toggle]"
          fathers={fathers.flatMap((f) => f.name ?? [])}
          focusFather
          align="start"
        />
      )}
    </div>
  )
}
