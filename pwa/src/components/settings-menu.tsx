import { useState, useRef, useEffect } from 'react'
import { Settings } from 'lucide-react'
import { ThemeToggle } from './theme-toggle'

interface Props {
  onOpenAbout: () => void
}

export function SettingsMenu({ onOpenAbout }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen])

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-zinc-200/50 dark:hover:bg-zinc-700/50 transition-colors"
        aria-label="Settings"
        aria-expanded={isOpen}
      >
        <Settings size={20} />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-2 w-56 rounded-xl bg-white dark:bg-zinc-800 shadow-lg p-2 z-50 border border-zinc-200 dark:border-zinc-700">
          {/* Theme Section */}
          <div className="px-3 py-2">
            <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">Theme</div>
            <ThemeToggle />
          </div>

          <hr className="my-2 border-zinc-300/30 dark:border-zinc-700/30" />

          {/* About */}
          <button
            onClick={() => {
              onOpenAbout()
              setIsOpen(false)
            }}
            className="w-full px-3 py-2 text-left rounded-lg hover:bg-zinc-200/50 dark:hover:bg-zinc-700/50 transition-colors"
          >
            About Termote
          </button>
        </div>
      )}
    </div>
  )
}
