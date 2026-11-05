import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useT } from '../i18n/i18n-context'
import type { AgentStatus, SessionGroup } from '../types/session'
import { avatarLetter, avatarTone } from '../utils/group-avatar'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { AgentStatusBadge, agentStatusLabel } from './agent-status-badge'
import { MetaChips } from './meta-chips'
import {
  ACTIVE_ROW_CLASSES,
  ROW_CLASSES,
  ROW_PRESS,
} from './sidebar-row-classes'
import { FOCUS_RING } from './ui/button'

interface Props {
  group: SessionGroup
  // The badge: the group's own, or with its worktrees' while they are hidden
  status?: AgentStatus
  // The group of the tab on screen
  active: boolean
  // A linked worktree under its checkout: indented, its branch for a name
  nested: boolean
  tabCount: number
  // A checkout with worktrees under it: a chevron shows or hides them
  collapsible: boolean
  collapsed: boolean
  // While a search holds the worktrees open: toggling would change the
  // saved state without showing it
  toggleDisabled?: boolean
  onToggle: () => void
  onSelect: () => void
  // Double click: rename, where the group can be renamed
  onRename?: () => void
  // Alt+Up/Down moves the group, where it can move
  onKeyDown?: (e: KeyboardEvent) => void
  // The row's main button, for focus to come back to
  buttonRef?: (el: HTMLButtonElement | null) => void
  keyShortcuts?: string
  // The group's actions, shown on hover or with focus inside
  menu?: ReactNode
}

// One workspace on one line (the compact sidebar): a letter on its colour,
// the name, its metadata (one chip, then +N), the branch on the right, the
// agents' badge and, on hover or with focus, its tab count and menu. Its tabs
// are in the header's bar, not here.
export function CompactGroupRow({
  group,
  status,
  active,
  nested,
  tabCount,
  collapsible,
  collapsed,
  toggleDisabled = false,
  onToggle,
  onSelect,
  onRename,
  onKeyDown,
  buttonRef,
  keyShortcuts,
  menu,
}: Props) {
  const { t } = useT()
  const name = visibleUnsafe(group.name || group.id)
  const branch = group.worktree?.branch && visibleUnsafe(group.worktree.branch)
  const shownName = nested ? branch || name : name
  // Spoken as one: the parts on screen would run into each other
  const label = [
    shownName,
    t('shell.sidebar.tabCount', { count: tabCount }),
    !nested && branch && `${t('shell.sidebar.branch')} ${branch}`,
    status && t(agentStatusLabel(status)),
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <div
      className={`group/crow relative flex items-center rounded-control ${ROW_PRESS} ${
        active ? ACTIVE_ROW_CLASSES : ROW_CLASSES
      } ${nested ? 'ml-3 border-l border-border' : ''}`}
    >
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          disabled={toggleDisabled}
          aria-expanded={!collapsed}
          aria-label={t('shell.sidebar.worktreesOf', { name })}
          className={`flex h-8 w-4 shrink-0 items-center justify-center rounded-control text-fg-subtle hover:text-fg ${FOCUS_RING}`}
        >
          {collapsed ? (
            <ChevronRight size={12} aria-hidden="true" />
          ) : (
            <ChevronDown size={12} aria-hidden="true" />
          )}
        </button>
      ) : (
        !nested && <span aria-hidden="true" className="w-4 shrink-0" />
      )}
      <button
        type="button"
        ref={buttonRef}
        aria-label={label}
        aria-current={active ? 'true' : undefined}
        aria-keyshortcuts={keyShortcuts}
        onClick={onSelect}
        onDoubleClick={onRename}
        onKeyDown={onKeyDown}
        title={branch ? `${name}\n${branch}` : name}
        className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control pl-1 pr-2 text-left text-[13px] ${FOCUS_RING} focus-visible:-outline-offset-2`}
      >
        {nested ? (
          <GitBranch
            size={14}
            aria-hidden="true"
            className="shrink-0 text-fg-subtle"
          />
        ) : (
          <span
            aria-hidden="true"
            className={`flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[11px] font-semibold leading-none text-white ${avatarTone(group.name || group.id)}`}
          >
            {avatarLetter(group.name || group.id)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate ui-terminal:font-label ui-terminal:text-[12px]">
          {shownName}
        </span>
        {/* Already in the button's name */}
        <span
          aria-hidden="true"
          className="hidden shrink-0 text-[11px] tabular-nums text-fg-subtle group-hover/crow:inline group-focus-within/crow:inline"
        >
          {tabCount}
        </span>
        <MetaChips tokens={group.meta} shown={1} className="max-w-[40%]" />
        {!nested && branch && (
          <span className="min-w-0 max-w-[45%] shrink truncate text-[11px] font-normal text-fg-subtle">
            {branch}
          </span>
        )}
        <AgentStatusBadge status={status} size={12} />
      </button>
      {/* opacity, not hidden: the button stays in the Tab order */}
      {menu && (
        <span className="absolute right-1 top-1/2 flex -translate-y-1/2 rounded-control bg-surface-raised opacity-0 pointer-coarse:opacity-100 group-hover/crow:opacity-100 group-focus-within/crow:opacity-100 has-[[aria-expanded=true]]:opacity-100">
          {menu}
        </span>
      )}
    </div>
  )
}
