import {
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { useGroupCollapsed } from '../hooks/use-group-collapsed'
import type { Session, SessionGroup } from '../types/session'
import { AgentStatusBadge } from './agent-status-badge'
import { IconPicker } from './icon-picker'
import { SwipeableSessionItem } from './swipeable-session-item'
import { Button, FOCUS_RING, IconButton } from './ui/button'
import { Sheet } from './ui/sheet'

// The row on screen: a soft accent fill, or an accent edge in the terminal style.
const ACTIVE_ROW_CLASSES =
  'bg-accent-soft text-fg font-medium ui-terminal:bg-surface-raised ui-terminal:shadow-[inset_2px_0_0_var(--color-accent)]'
const ROW_CLASSES =
  'text-fg-muted hover:bg-surface-raised hover:text-fg transition-colors duration-(--duration-fast)'
const SIDEBAR_BASE_CLASSES =
  'h-full min-h-0 flex flex-col shrink-0 border-r border-border bg-surface ui-terminal:bg-bg transition-[width] duration-(--duration-base) ease-standard'
const INPUT_CLASSES =
  'h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch'

interface Props {
  sessions: Session[]
  // Groups the sessions belong to; headers show only when there are several.
  groups?: SessionGroup[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: (name: string, icon?: string, description?: string) => void
  onRemove: (id: string) => void
  onUpdate?: (id: string, updates: Partial<Omit<Session, 'id'>>) => void
  // Mobile: whether the sessions sheet is open
  isOpen?: boolean
  onClose?: () => void
  isMobile?: boolean
  isCollapsed?: boolean
  onToggleCollapse?: () => void
}

// The session list: a bottom sheet on phones, a collapsible sidebar on desktop.
export function SessionSidebar({
  sessions,
  groups = [],
  activeId,
  onSelect,
  onAdd,
  onRemove,
  onUpdate,
  isOpen = true,
  onClose = () => {},
  isMobile = false,
  isCollapsed = false,
  onToggleCollapse,
}: Props) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newIcon, setNewIcon] = useState('💻')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editIcon, setEditIcon] = useState('')
  const { isCollapsed: isGroupCollapsed, toggle: toggleGroup } =
    useGroupCollapsed()

  const handleAdd = () => {
    if (newName.trim()) {
      onAdd(newName.trim(), newIcon)
      setNewName('')
      setNewIcon('💻')
      setShowAddForm(false)
    }
  }

  const startEdit = (session: Session) => {
    setEditingId(session.id)
    setEditName(session.name)
    setEditIcon(session.icon)
  }

  const saveEdit = () => {
    if (editingId && editName.trim() && onUpdate) {
      onUpdate(editingId, { name: editName.trim(), icon: editIcon })
    }
    setEditingId(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
  }

  // Edit form (shared)
  const renderEditForm = () => (
    <div className="flex flex-col gap-2 rounded-control border border-border bg-bg p-2">
      <div className="flex min-w-0 items-center gap-2">
        <IconPicker value={editIcon} onChange={setEditIcon} />
        <input
          type="text"
          aria-label="Session name"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          className={INPUT_CLASSES}
          autoFocus
        />
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={saveEdit}
          className="flex-1"
        >
          Save
        </Button>
        <Button size="sm" onClick={cancelEdit}>
          Cancel
        </Button>
      </div>
    </div>
  )

  // Desktop session item; edit and remove show on hover or keyboard focus
  const renderDesktopItem = (session: Session) => {
    const active = activeId === session.id
    return (
      <div
        className={`group relative flex items-center rounded-control ${
          active ? ACTIVE_ROW_CLASSES : ROW_CLASSES
        }`}
      >
        <button
          type="button"
          aria-current={active ? 'true' : undefined}
          onClick={() => onSelect(session.id)}
          onDoubleClick={() => onUpdate && startEdit(session)}
          title={
            session.description
              ? `${session.name} - ${session.description}`
              : undefined
          }
          className={`flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-control px-2 text-left text-[14px] ${FOCUS_RING} focus-visible:-outline-offset-2`}
        >
          <span className="shrink-0 text-[15px] leading-none">
            {session.icon}
          </span>
          <span className="flex-1 truncate ui-terminal:font-label ui-terminal:text-[13px]">
            {session.name}
          </span>
          <AgentStatusBadge status={session.agentStatus} />
        </button>
        <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 gap-0.5 rounded-control bg-surface-raised group-focus-within:flex group-hover:flex">
          {onUpdate && (
            <IconButton
              size="sm"
              onClick={() => startEdit(session)}
              className="size-7!"
              title="Edit session"
              aria-label={`Edit ${session.name}`}
            >
              <Pencil size={14} aria-hidden="true" />
            </IconButton>
          )}
          {sessions.length > 1 && (
            <IconButton
              size="sm"
              variant="danger"
              onClick={() => onRemove(session.id)}
              className="size-7!"
              title="Remove session"
              aria-label={`Remove ${session.name}`}
            >
              <X size={14} aria-hidden="true" />
            </IconButton>
          )}
        </div>
      </div>
    )
  }

  const renderItem = (session: Session) => (
    <div key={session.id}>
      {editingId === session.id ? (
        renderEditForm()
      ) : isMobile ? (
        <SwipeableSessionItem
          session={session}
          isActive={activeId === session.id}
          onSelect={() => onSelect(session.id)}
          onEdit={() => startEdit(session)}
          onRemove={() => onRemove(session.id)}
          canRemove={sessions.length > 1}
          canEdit={!!onUpdate}
        />
      ) : (
        renderDesktopItem(session)
      )}
    </div>
  )

  const rowGap = isMobile ? 'gap-1 ui-native:gap-px' : 'gap-0.5'

  // A single group (tmux) keeps the flat 0.x list without a header.
  const renderGroup = (group: SessionGroup) => {
    const tabs = sessions.filter((s) => s.groupId === group.id)
    const collapsed = isGroupCollapsed(group.id)
    const name = group.name || group.id
    return (
      <section key={group.id} aria-label={name} className="pb-2">
        <button
          type="button"
          onClick={() => toggleGroup(group.id)}
          aria-expanded={!collapsed}
          className={`flex w-full items-center gap-1.5 rounded-control px-2 pb-1 pt-2 font-label text-[11px] uppercase tracking-wider text-fg-subtle hover:text-fg ${FOCUS_RING}`}
        >
          {collapsed ? (
            <ChevronRight size={12} aria-hidden="true" />
          ) : (
            <ChevronDown size={12} aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{name}</span>
          <AgentStatusBadge status={group.agentStatus} size={12} />
          <span className="ml-1 tabular-nums">{tabs.length}</span>
        </button>
        {!collapsed && (
          <div
            className={`flex flex-col ${rowGap} ui-native:overflow-hidden ui-native:rounded-panel`}
          >
            {tabs.map(renderItem)}
          </div>
        )}
      </section>
    )
  }

  const addForm = (
    <div className="flex flex-col gap-2 rounded-control border border-border bg-bg p-2">
      <div className="flex min-w-0 items-center gap-2">
        <IconPicker value={newIcon} onChange={setNewIcon} />
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="Session name"
          className={INPUT_CLASSES}
          autoFocus
        />
      </div>
      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={handleAdd}
          className="flex-1"
        >
          Add
        </Button>
        <Button size="sm" onClick={() => setShowAddForm(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )

  // Session list content (shared between mobile and desktop)
  const sessionList =
    groups.length > 1 ? (
      groups.map(renderGroup)
    ) : (
      <div
        className={`flex flex-col ${rowGap} ui-native:overflow-hidden ui-native:rounded-panel`}
      >
        {sessions.map(renderItem)}
      </div>
    )

  // Mobile: bottom sheet; adding a session starts from its header
  if (isMobile) {
    return (
      <Sheet
        isOpen={isOpen}
        onClose={onClose}
        title="Sessions"
        closeLabel="Close sessions"
        actions={
          !showAddForm && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setShowAddForm(true)}
              title="Add new session"
              className="ui-native:rounded-full"
            >
              <Plus size={16} aria-hidden="true" />
              New session
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-2 px-2 pb-3 pt-1">
          {showAddForm && addForm}
          {sessionList}
        </div>
      </Sheet>
    )
  }

  // Desktop: collapsible sidebar
  if (isCollapsed) {
    return (
      <aside className={`w-14 items-center gap-1 py-2 ${SIDEBAR_BASE_CLASSES}`}>
        <IconButton
          onClick={() => onToggleCollapse?.()}
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <PanelLeftOpen size={18} aria-hidden="true" />
        </IconButton>
        <IconButton
          variant="primary"
          onClick={() => {
            onToggleCollapse?.()
            setShowAddForm(true)
          }}
          title="Add new session"
          aria-label="Add new session"
        >
          <Plus size={18} aria-hidden="true" />
        </IconButton>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto pt-1">
          {sessions.map((session) => {
            const active = activeId === session.id
            return (
              <button
                key={session.id}
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => onSelect(session.id)}
                className={`flex size-10 shrink-0 items-center justify-center rounded-control ${FOCUS_RING} ${
                  active ? ACTIVE_ROW_CLASSES : ROW_CLASSES
                }`}
                title={session.name}
              >
                <span className="relative text-lg leading-none">
                  {session.icon}
                  {session.agentStatus && (
                    <span className="absolute -top-1.5 -right-2 flex size-3.5 items-center justify-center rounded-full bg-surface ui-terminal:bg-bg">
                      <AgentStatusBadge
                        status={session.agentStatus}
                        size={10}
                      />
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </aside>
    )
  }

  // Desktop: expanded sidebar
  return (
    <aside className={`w-64 ${SIDEBAR_BASE_CLASSES}`}>
      <div className="flex h-12 shrink-0 items-center justify-between pl-3 pr-1.5">
        <span className="flex items-center gap-2 text-[15px] font-semibold text-fg ui-terminal:font-label">
          <span
            aria-hidden="true"
            className="flex size-6 items-center justify-center rounded-control bg-accent font-label text-[12px] font-bold text-accent-fg"
          >
            ›_
          </span>
          termote
        </span>
        <IconButton
          onClick={() => onToggleCollapse?.()}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <PanelLeftClose size={18} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="shrink-0 px-3 pb-2">
        {showAddForm ? (
          addForm
        ) : (
          <Button
            variant="primary"
            onClick={() => setShowAddForm(true)}
            title="Add new session"
            className="w-full ui-native:rounded-full"
          >
            <Plus size={16} aria-hidden="true" />
            New session
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessionList}
      </div>
    </aside>
  )
}
