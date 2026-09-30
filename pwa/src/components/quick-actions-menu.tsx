import { Ban, Eraser, LogOut, Sparkles, X, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useHaptic } from '../hooks/use-haptic'
import { FOCUS_RING } from './ui/button'
import { Sheet } from './ui/sheet'

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

export interface QuickActionHandlers {
  onSendKey: (key: string, opts?: { ctrl?: boolean }) => void
  onSendText: (text: string) => void
}

interface Props extends QuickActionHandlers {
  // View-only session: render nothing, there is nothing to send
  readOnly?: boolean
}

function runAction(
  action: Action,
  { onSendKey, onSendText }: QuickActionHandlers,
) {
  if (action.text) {
    onSendText(action.text)
    onSendKey('Enter')
  } else {
    onSendKey(action.key, { ctrl: action.ctrl })
  }
}

// The same action list as the floating button, in a sheet. The toolbar's
// Quick actions key opens it.
export function QuickActionsSheet({
  isOpen,
  onClose,
  onSendKey,
  onSendText,
}: QuickActionHandlers & { isOpen: boolean; onClose: () => void }) {
  const { trigger: haptic } = useHaptic()
  return (
    <Sheet isOpen={isOpen} onClose={onClose} title="Quick actions">
      <div className="py-1">
        {ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => {
              haptic('medium')
              runAction(action, { onSendKey, onSendText })
              onClose()
            }}
            className={`flex h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-fg hover:bg-surface ui-terminal:font-label ui-terminal:text-[13px] ${FOCUS_RING} focus-visible:-outline-offset-2`}
          >
            <span aria-hidden="true" className="text-fg-muted">
              {action.icon}
            </span>
            {action.label}
          </button>
        ))}
      </div>
    </Sheet>
  )
}

export function QuickActionsMenu({ onSendKey, onSendText, readOnly }: Props) {
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
      runAction(action, { onSendKey, onSendText })
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
      /* v8 ignore next */
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
      /* v8 ignore next */
      if (el) {
        const finalPos = {
          right: Number.parseInt(el.style.right, 10) || 16,
          bottom: Number.parseInt(el.style.bottom, 10) || 112,
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

  if (readOnly) return null

  return (
    <div
      ref={menuRef}
      className="fixed z-30"
      style={{ right: position.right, bottom: position.bottom }}
    >
      {/* Popup menu — flip horizontal/vertical based on FAB position */}
      {isOpen && (
        <div
          className={`absolute flex flex-col gap-2 transition-opacity duration-(--duration-fast) ease-standard starting:opacity-0 ${
            position.right > window.innerWidth / 2 ? 'left-0' : 'right-0'
          } ${
            position.bottom > window.innerHeight / 2 ? 'top-14' : 'bottom-14'
          }`}
        >
          {ACTIONS.map((action) => (
            <button
              key={action.label}
              onClick={() => handleAction(action)}
              className={`flex h-11 items-center gap-2 rounded-control border border-border bg-surface-raised px-3 text-fg shadow-lg whitespace-nowrap hover:border-border-strong transition-colors duration-(--duration-fast) ease-standard ui-native:border-0 ${FOCUS_RING}`}
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
        className={`flex h-12 w-12 touch-none items-center justify-center rounded-full shadow-lg transition-colors duration-(--duration-fast) ease-standard hover:opacity-90 ${FOCUS_RING} ${
          isOpen ? 'rotate-45 bg-danger text-white' : 'bg-accent text-accent-fg'
        }`}
        aria-label={isOpen ? 'Close menu' : 'Quick actions'}
      >
        {isOpen ? <X size={24} /> : <Zap size={24} />}
      </button>
    </div>
  )
}
