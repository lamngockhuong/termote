import { useState } from 'react'

const ICONS = [
  '💻',
  '🤖',
  '🐙',
  '📺',
  '🔧',
  '🚀',
  '⚡',
  '🎯',
  '📁',
  '🌐',
  '🔒',
  '📊',
  '🎨',
  '🔥',
  '💡',
  '🎮',
  '📝',
  '🛠️',
]

interface Props {
  value: string
  onChange: (icon: string) => void
}

export function IconPicker({ value, onChange }: Props) {
  const [isOpen, setIsOpen] = useState(false)

  const handleSelect = (icon: string) => {
    onChange(icon)
    setIsOpen(false)
  }

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="w-10 h-10 text-xl rounded-lg bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors flex items-center justify-center shrink-0"
        title="Change icon"
      >
        {value}
      </button>

      {/* Modal */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50 z-50"
            onClick={() => setIsOpen(false)}
          />
          {/* Modal content */}
          <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-zinc-100 dark:bg-zinc-800 rounded-xl p-4 shadow-xl min-w-[280px]">
            <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">
              Choose Icon
            </div>
            <div className="grid grid-cols-6 gap-2">
              {ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  onClick={() => handleSelect(icon)}
                  className={`w-10 h-10 text-xl rounded-lg transition-all flex items-center justify-center ${
                    value === icon
                      ? 'bg-blue-600 text-white ring-2 ring-blue-400'
                      : 'bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 hover:scale-110'
                  }`}
                >
                  {icon}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="mt-3 w-full py-2 text-sm text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </>
  )
}
