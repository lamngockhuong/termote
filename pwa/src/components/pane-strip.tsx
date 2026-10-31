import { X } from 'lucide-react'
import { useT } from '../i18n/i18n-context'
import type { SessionPane } from '../types/session'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { AgentStatusBadge } from './agent-status-badge'
import { MetaChips } from './meta-chips'
import { FOCUS_RING } from './ui/button'

interface Props {
  panes: SessionPane[]
  activePaneId?: string
  // Picks a pane; without it (a view-only device on tmux, where picking
  // moves the focus every client shares) the strip only shows the panes.
  onSelect?: (paneId: string) => void
  // Asks to close a pane; without it no close button is shown.
  onClose?: (paneId: string) => void
}

// Picks which pane of a split tab the terminal streams (Herdr, Zellij) or
// has the focus (tmux, whose stream shows the whole window). Only rendered
// for tabs with more than one pane, so closing a pane here never closes the
// tab.
// Each close button is a sibling of its pane button, never nested in it.
export function PaneStrip({ panes, activePaneId, onSelect, onClose }: Props) {
  const { t } = useT()
  if (panes.length < 2) return null
  // The command under a pane's label, unless it only repeats the label (an
  // agent pane named after what it runs). When one pane shows a command,
  // every button keeps room for it, so the strip does not change height.
  const commandOf = (pane: SessionPane) =>
    pane.command && pane.command !== pane.label ? pane.command : undefined
  const twoLines = panes.some((p) => commandOf(p))
  return (
    <fieldset
      data-tour="pane-strip"
      aria-label={t('common.panes')}
      className="m-0 flex min-w-0 shrink-0 items-center gap-1 overflow-x-auto border-0 border-b border-border bg-term px-2 py-1 scrollbar-hide"
    >
      {panes.map((pane) => {
        const active = pane.id === activePaneId
        const command = commandOf(pane)
        return (
          <div
            key={pane.id}
            className={`group flex shrink-0 items-center rounded-control transition-colors duration-(--duration-fast) ${
              active
                ? 'bg-accent-soft text-accent'
                : 'text-fg-muted hover:bg-surface hover:text-fg'
            }`}
          >
            <button
              type="button"
              aria-pressed={active}
              disabled={!onSelect}
              onClick={() => onSelect?.(pane.id)}
              className={`flex items-center gap-1.5 whitespace-nowrap px-2 text-[12px] rounded-control touch-manipulation pointer-coarse:h-touch ui-terminal:font-label disabled:cursor-default ${FOCUS_RING} ${
                twoLines ? 'h-9' : 'h-7'
              } ${onClose ? 'pr-1' : ''}`}
            >
              <AgentStatusBadge status={pane.agentStatus} size={12} />
              <span className="flex min-w-0 flex-col text-left leading-tight">
                <span className="max-w-[140px] truncate">
                  {visibleUnsafe(pane.label)}
                </span>
                {command && (
                  <span className="max-w-[140px] truncate text-[11px] text-fg-subtle">
                    {visibleUnsafe(command)}
                  </span>
                )}
              </span>
              <MetaChips tokens={pane.meta} />
            </button>
            {onClose && (
              <button
                type="button"
                onClick={() => onClose(pane.id)}
                className={`mr-1 flex size-5 items-center justify-center rounded-[calc(var(--radius-control)-2px)] text-fg-subtle touch-manipulation hover:bg-surface hover:text-fg pointer-coarse:size-8 ${FOCUS_RING} ${
                  active
                    ? ''
                    : 'invisible group-hover:visible group-focus-within:visible pointer-coarse:visible'
                }`}
                aria-label={t('shell.panes.close', { name: pane.label })}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        )
      })}
    </fieldset>
  )
}
