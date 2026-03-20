import { Pencil, Plus, X } from 'lucide-react'
import { useState } from 'react'
import type { Session } from '../types/session'
import { IconPicker } from './icon-picker'
import { SwipeableSessionItem } from './swipeable-session-item'

interface Props {
  sessions: Session[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: (name: string, icon?: string, description?: string) => void
  onRemove: (id: string) => void
  onUpdate?: (id: string, updates: Partial<Omit<Session, 'id'>>) => void
  isOpen?: boolean
  onClose?: () => void
  isMobile?: boolean
}

export function SessionSidebar({
  sessions,
  activeId,
  onSelect,
  onAdd,
  onRemove,
  onUpdate,
  isOpen = true,
  onClose,
  isMobile = false,
}: Props) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [newIcon, setNewIcon] = useState('💻')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editIcon, setEditIcon] = useState('')

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
    <div className="p-3 border-b border-zinc-300/30 dark:border-zinc-700/30 overflow-hidden">
      {/* Icon + Name on same row */}
      <div className="flex items-center gap-2 mb-2 min-w-0">
        <IconPicker value={editIcon} onChange={setEditIcon} />
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          className="flex-1 min-w-0 px-2 py-2 text-sm bg-zinc-200/50 dark:bg-zinc-800/50 border border-zinc-400/30 dark:border-zinc-600/30 rounded-lg focus:border-blue-500 outline-none"
          autoFocus
        />
      </div>
      {/* Buttons */}
      <div className="flex gap-2">
        <button
          onClick={saveEdit}
          className="flex-1 px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 rounded-lg text-white"
        >
          Save
        </button>
        <button
          onClick={cancelEdit}
          className="px-3 py-1.5 text-xs bg-zinc-300/50 dark:bg-zinc-700/50 hover:bg-zinc-400/50 dark:hover:bg-zinc-600/50 rounded-lg"
        >
          Cancel
        </button>
      </div>
    </div>
  )

  // Desktop session item
  const renderDesktopItem = (session: Session) => (
    <div
      className={`group relative flex items-center hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors ${
        activeId === session.id
          ? 'bg-zinc-200 dark:bg-zinc-700 border-l-2 border-blue-500'
          : ''
      }`}
    >
      <button
        onClick={() => onSelect(session.id)}
        onDoubleClick={() => onUpdate && startEdit(session)}
        className="flex-1 p-3 text-left text-zinc-900 dark:text-zinc-50 flex items-center min-w-0"
      >
        <span className="text-xl shrink-0">{session.icon}</span>
        <span className="ml-2 text-sm truncate">{session.name}</span>
      </button>
      <div className="hidden group-hover:flex absolute right-1 top-1/2 -translate-y-1/2 gap-1">
        {onUpdate && (
          <button
            onClick={() => startEdit(session)}
            className="w-6 h-6 text-xs text-zinc-500 dark:text-zinc-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-zinc-300/50 dark:hover:bg-zinc-600/50 rounded transition-colors flex items-center justify-center"
            title="Edit session"
          >
            <Pencil size={14} />
          </button>
        )}
        {sessions.length > 1 && (
          <button
            onClick={() => onRemove(session.id)}
            className="w-6 h-6 text-xs text-zinc-500 dark:text-zinc-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-zinc-300/50 dark:hover:bg-zinc-600/50 rounded transition-colors flex items-center justify-center"
            title="Remove session"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )

  // Session list content (shared between mobile and desktop)
  const sessionList = (
    <>
      {sessions.map((session) => (
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
      ))}

      {/* Add session button/form */}
      {showAddForm ? (
        <div className="p-3 border-t border-zinc-300/30 dark:border-zinc-700/30">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="Session name"
            className="w-full px-2 py-1 text-sm bg-zinc-200/50 dark:bg-zinc-800/50 border border-zinc-400/30 dark:border-zinc-600/30 rounded-lg focus:border-blue-500 outline-none mb-2"
            autoFocus
          />
          <IconPicker value={newIcon} onChange={setNewIcon} />
          <div className="flex gap-1 mt-2">
            <button
              onClick={handleAdd}
              className="flex-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded-lg text-white"
            >
              Add
            </button>
            <button
              onClick={() => setShowAddForm(false)}
              className="px-2 py-1 text-xs bg-zinc-300/50 dark:bg-zinc-700/50 hover:bg-zinc-400/50 dark:hover:bg-zinc-600/50 rounded-lg"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="p-3 text-left hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors border-t border-zinc-200 dark:border-zinc-700 w-full text-zinc-600 dark:text-zinc-400 flex items-center"
          title="Add new session"
        >
          <Plus size={20} />
          <span
            className={`${isMobile ? 'inline' : 'hidden md:inline'} ml-2 text-sm`}
          >
            Add session
          </span>
        </button>
      )}
    </>
  )

  // Mobile: slide-over panel
  if (isMobile) {
    return (
      <>
        {/* Backdrop */}
        {isOpen && (
          <div
            className="fixed inset-0 bg-black/50 z-40 animate-fade-in"
            onClick={onClose}
          />
        )}
        {/* Panel */}
        <aside
          className={`fixed left-0 top-0 bottom-0 w-72 z-50 bg-zinc-50 dark:bg-zinc-800 flex flex-col transform transition-transform duration-200 ease-out ${
            isOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="p-4 border-b border-zinc-200 dark:border-zinc-700 flex justify-between items-center shrink-0">
            <span className="font-semibold text-zinc-900 dark:text-zinc-50">
              Sessions
            </span>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-zinc-200/50 dark:hover:bg-zinc-700/50 transition-colors"
            >
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">{sessionList}</div>
        </aside>
      </>
    )
  }

  // Desktop: normal sidebar
  return (
    <aside className="w-56 h-full min-h-0 bg-zinc-50 dark:bg-zinc-800 flex flex-col border-r border-zinc-200 dark:border-zinc-700 shrink-0">
      <div className="flex-1 min-h-0 overflow-y-auto">{sessionList}</div>
    </aside>
  )
}
