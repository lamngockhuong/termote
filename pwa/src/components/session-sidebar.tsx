import { useState } from 'react'
import { Session } from '../types/session'

interface Props {
  sessions: Session[]
  activeId: string
  onSelect: (id: string) => void
  onAdd: (name: string, icon?: string, description?: string) => void
  onRemove: (id: string) => void
}

export function SessionSidebar({ sessions, activeId, onSelect, onAdd, onRemove }: Props) {
  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')

  const handleAdd = () => {
    if (newName.trim()) {
      onAdd(newName.trim())
      setNewName('')
      setShowAddForm(false)
    }
  }

  return (
    <aside className="w-16 md:w-48 bg-zinc-900 flex flex-col border-r border-zinc-700">
      {sessions.map((session) => (
        <div
          key={session.id}
          className={`group relative flex items-center hover:bg-zinc-800 transition-colors ${
            activeId === session.id ? 'bg-zinc-700 border-l-2 border-blue-500' : ''
          }`}
        >
          <button
            onClick={() => onSelect(session.id)}
            className="flex-1 p-3 text-left"
          >
            <span className="text-xl">{session.icon}</span>
            <span className="hidden md:inline ml-2 text-sm">{session.name}</span>
          </button>
          {sessions.length > 1 && (
            <button
              onClick={() => onRemove(session.id)}
              className="hidden group-hover:block absolute right-1 top-1/2 -translate-y-1/2
                         w-5 h-5 text-xs text-zinc-400 hover:text-red-400 hover:bg-zinc-600
                         rounded transition-colors"
              title="Remove session"
            >
              ×
            </button>
          )}
        </div>
      ))}

      {/* Add session button/form */}
      {showAddForm ? (
        <div className="p-2 border-t border-zinc-700">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="Name"
            className="w-full px-2 py-1 text-sm bg-zinc-800 border border-zinc-600
                       rounded focus:border-blue-500 outline-none"
            autoFocus
          />
          <div className="flex gap-1 mt-1">
            <button
              onClick={handleAdd}
              className="flex-1 px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded"
            >
              Add
            </button>
            <button
              onClick={() => setShowAddForm(false)}
              className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded"
            >
              ✕
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="p-3 text-left hover:bg-zinc-800 transition-colors border-t border-zinc-700"
          title="Add new session"
        >
          <span className="text-xl">➕</span>
          <span className="hidden md:inline ml-2 text-sm text-zinc-400">Add session</span>
        </button>
      )}
    </aside>
  )
}
