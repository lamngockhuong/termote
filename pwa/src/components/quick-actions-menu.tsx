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
const FAB_STORAGE_KEY = 'termote-fab-position'
const FAB_SIZE = 48

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

function loadPosition(): { right: number; bottom: number } | null {
  try {
    const json = localStorage.getItem(FAB_STORAGE_KEY)
    return json ? JSON.parse(json) : null
  } catch {
    return null
  }
}

function savePosition(pos: { right: number; bottom: number }) {
  localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify(pos))
}

interface Props {
  onSendKey: (key: string, opts?: { ctrl?: boolean }) => void
  onSendText: (text: string) => void
}

export function QuickActionsMenu({ onSendKey, onSendText }: Props) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const { trigger: haptic } = useHaptic()
  const [position, setPosition] = useState(
    () => loadPosition() ?? { right: 16, bottom: 112 },
  )
  const isDragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0, right: 0, bottom: 0 })
  const hasMoved = useRef(false)

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

  // Clamp position within viewport bounds
  const clampPosition = useCallback(
    (right: number, bottom: number) => ({
      right: Math.max(4, Math.min(right, window.innerWidth - FAB_SIZE - 4)),
      bottom: Math.max(4, Math.min(bottom, window.innerHeight - FAB_SIZE - 4)),
    }),
    [],
  )

  // Touch drag — manipulate DOM directly for smooth 60fps, sync state on end
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0]
      isDragging.current = true
      hasMoved.current = false
      dragStart.current = {
        x: touch.clientX,
        y: touch.clientY,
        right: position.right,
        bottom: position.bottom,
      }
    },
    [position],
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isDragging.current) return
      const touch = e.touches[0]
      const dx = dragStart.current.x - touch.clientX
      const dy = dragStart.current.y - touch.clientY

      if (!hasMoved.current && Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      hasMoved.current = true

      // Direct DOM update — no React re-render
      const el = menuRef.current
      if (el) {
        const clamped = clampPosition(
          dragStart.current.right + dx,
          dragStart.current.bottom + dy,
        )
        el.style.right = `${clamped.right}px`
        el.style.bottom = `${clamped.bottom}px`
      }
    },
    [clampPosition],
  )

  const handleTouchEnd = useCallback(() => {
    if (!isDragging.current) return
    isDragging.current = false
    if (hasMoved.current) {
      // Read final position from DOM, commit to state + localStorage
      const el = menuRef.current
      if (el) {
        const finalPos = {
          right: Number.parseInt(el.style.right) || 16,
          bottom: Number.parseInt(el.style.bottom) || 112,
        }
        setPosition(finalPos)
        savePosition(finalPos)
      }
      // Reset after onClick fires (same event loop) so FAB stays tappable
      requestAnimationFrame(() => {
        hasMoved.current = false
      })
    }
  }, [])

  const toggleMenu = useCallback(() => {
    // Don't toggle if we just finished dragging
    if (hasMoved.current) return
    haptic('light')
    setIsOpen((prev) => !prev)
  }, [haptic])

  return (
    <div
      ref={menuRef}
      className="fixed z-30"
      style={{ right: position.right, bottom: position.bottom }}
    >
      {/* Popup menu — flip horizontal/vertical based on FAB position */}
      {isOpen && (
        <div
          className={`absolute flex flex-col gap-2 animate-in fade-in duration-150 ${
            position.right > window.innerWidth / 2 ? 'left-0' : 'right-0'
          } ${
            position.bottom > window.innerHeight / 2 ? 'top-14' : 'bottom-14'
          }`}
        >
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

      {/* FAB button — draggable via touch */}
      <button
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={toggleMenu}
        className={`w-12 h-12 flex items-center justify-center rounded-full shadow-lg transition-colors touch-none ${
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
