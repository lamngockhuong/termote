import { Ban, Eraser, LogOut, Sparkles, X, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useHaptic } from '../hooks/use-haptic'

interface Action {
  icon: React.ReactNode
  label: string
  key: string
  ctrl?: boolean
  text?: string // For sending text like "clear"
}

const ICON_SIZE = 18

const ACTIONS: Action[] = [
  {
    icon: <Eraser size={ICON_SIZE} />,
    label: 'Clear',
    text: 'clear',
    key: 'Enter',
  },
  { icon: <Ban size={ICON_SIZE} />, label: 'Cancel', key: 'c', ctrl: true },
  {
    icon: <Sparkles size={ICON_SIZE} />,
    label: 'Clear line',
    key: 'u',
    ctrl: true,
  },
  { icon: <LogOut size={ICON_SIZE} />, label: 'Exit', key: 'd', ctrl: true },
]

interface Props {
  onSendKey: (key: string, opts?: { ctrl?: boolean }) => void
  onSendText: (text: string) => void
}

export function QuickActionsMenu({ onSendKey, onSendText }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { trigger: haptic } = useHaptic()

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  const handleAction = useCallback(
    (action: Action) => {
      haptic('medium')
      if (action.text) {
        onSendText(action.text)
        onSendKey('Enter')
      } else {
        onSendKey(action.key, { ctrl: action.ctrl })
      }
      setIsOpen(false)
    },
    [haptic, onSendKey, onSendText],
  )

  const toggleMenu = useCallback(() => {
    haptic('light')
    setIsOpen((prev) => !prev)
  }, [haptic])

  return (
    <div ref={menuRef} className="fixed bottom-28 right-4 z-30">
      {/* Popup menu */}
      {isOpen && (
        <div className="absolute bottom-14 right-0 flex flex-col gap-2 animate-in fade-in slide-in-from-bottom-2 duration-150">
          {ACTIONS.map((action) => (
            <button
              key={action.label}
              onClick={() => handleAction(action)}
              className="flex items-center gap-2 px-3 py-2 bg-zinc-800 dark:bg-zinc-700 text-white rounded-lg shadow-lg whitespace-nowrap hover:bg-zinc-700 dark:hover:bg-zinc-600 transition-colors"
            >
              {action.icon}
              <span className="text-sm">{action.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* FAB button */}
      <button
        onClick={toggleMenu}
        className={`w-12 h-12 flex items-center justify-center rounded-full shadow-lg transition-all ${
          isOpen
            ? 'bg-red-500 rotate-45 hover:bg-red-400'
            : 'bg-blue-600 hover:bg-blue-500'
        }`}
        aria-label={isOpen ? 'Close menu' : 'Quick actions'}
      >
        {isOpen ? (
          <X size={24} className="text-white" />
        ) : (
          <Zap size={24} className="text-white" />
        )}
      </button>
    </div>
  )
}
