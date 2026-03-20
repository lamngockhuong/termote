import { useState, useCallback, ReactNode } from 'react'
import { useHaptic } from '../hooks/use-haptic'
import {
  Keyboard,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ChevronsUp,
  ChevronsDown,
  History,
} from 'lucide-react'

interface Props {
  onKey: (key: string) => void
  onCtrlKey: (key: string) => void
  onScroll?: (direction: 'up' | 'down', pages?: boolean) => void
  onTmuxCopy?: () => void
  onToggleKeyboard?: () => void
}

interface KeyConfig {
  label: ReactNode
  key: string
  isModifier?: boolean
  isScroll?: boolean
  scrollDir?: 'up' | 'down'
  isTmuxCopy?: boolean
  isKeyboardToggle?: boolean
}

const ICON_SIZE = 18

const KEYS: KeyConfig[] = [
  { label: <Keyboard size={ICON_SIZE} />, key: 'Keyboard', isKeyboardToggle: true },
  { label: 'Tab', key: 'Tab' },
  { label: 'Esc', key: 'Escape' },
  { label: 'Ctrl', key: 'Control', isModifier: true },
  { label: <ArrowUp size={ICON_SIZE} />, key: 'ArrowUp' },
  { label: <ArrowDown size={ICON_SIZE} />, key: 'ArrowDown' },
  { label: <ArrowLeft size={ICON_SIZE} />, key: 'ArrowLeft' },
  { label: <ArrowRight size={ICON_SIZE} />, key: 'ArrowRight' },
  { label: <History size={ICON_SIZE} />, key: 'TmuxCopy', isTmuxCopy: true },
  { label: <ChevronsUp size={ICON_SIZE} />, key: 'ScrollUp', isScroll: true, scrollDir: 'up' },
  { label: <ChevronsDown size={ICON_SIZE} />, key: 'ScrollDown', isScroll: true, scrollDir: 'down' },
]

const CTRL_COMBOS = [
  { label: 'B', combo: 'b' },
  { label: 'C', combo: 'c' },
  { label: 'D', combo: 'd' },
  { label: 'Z', combo: 'z' },
  { label: 'L', combo: 'l' },
  { label: 'A', combo: 'a' },
  { label: 'E', combo: 'e' },
]

export function KeyboardToolbar({ onKey, onCtrlKey, onScroll, onTmuxCopy, onToggleKeyboard }: Props) {
  const [ctrlActive, setCtrlActive] = useState(false)
  const { trigger: haptic } = useHaptic()

  const handleKey = useCallback(
    (key: string, opts?: { isModifier?: boolean; scrollDir?: 'up' | 'down'; isTmuxCopy?: boolean; isKeyboardToggle?: boolean }) => {
      haptic('light')
      if (opts?.isKeyboardToggle && onToggleKeyboard) {
        onToggleKeyboard()
        return
      }
      if (opts?.isTmuxCopy && onTmuxCopy) {
        onTmuxCopy()
        return
      }
      if (opts?.scrollDir && onScroll) {
        onScroll(opts.scrollDir)
        return
      }
      if (opts?.isModifier) {
        setCtrlActive((prev) => !prev)
      } else if (ctrlActive) {
        onCtrlKey(key.toLowerCase())
        setCtrlActive(false)
      } else {
        onKey(key)
      }
    },
    [ctrlActive, onKey, onCtrlKey, onScroll, onTmuxCopy, onToggleKeyboard, haptic]
  )

  return (
    <div className="flex items-center gap-2 px-3 py-2 pb-safe glass-surface border-t border-zinc-300/30 dark:border-zinc-700/30 overflow-x-auto" style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.5rem)' }}>
      {KEYS.map(({ label, key, isModifier, isScroll, scrollDir, isTmuxCopy, isKeyboardToggle }) => (
        <button
          key={key}
          onMouseDown={(e) => !isKeyboardToggle && e.preventDefault()}
          onTouchStart={(e) => !isKeyboardToggle && e.preventDefault()}
          onContextMenu={(e) => e.preventDefault()}
          onClick={() => handleKey(key, { isModifier, scrollDir, isTmuxCopy, isKeyboardToggle })}
          className={`min-w-11 h-11 px-3 flex items-center justify-center rounded-xl text-sm font-mono
            ${isModifier && ctrlActive ? 'bg-blue-600 text-white' : isKeyboardToggle ? 'bg-purple-200/70 dark:bg-purple-700/50' : isTmuxCopy ? 'bg-amber-200/70 dark:bg-amber-700/50' : isScroll ? 'bg-green-200/70 dark:bg-green-800/50' : 'bg-zinc-200/70 dark:bg-zinc-700/70'}
            active:bg-zinc-300 dark:active:bg-zinc-600 touch-manipulation transition-colors`}
        >
          {label}
        </button>
      ))}

      {ctrlActive && (
        <div className="flex gap-1 ml-1 pl-2 border-l border-zinc-300 dark:border-zinc-600">
          {CTRL_COMBOS.map(({ label, combo }) => (
            <button
              key={combo}
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onContextMenu={(e) => e.preventDefault()}
              onClick={() => handleKey(combo)}
              className="min-w-11 h-11 px-2 flex items-center justify-center rounded-xl text-sm font-mono bg-blue-500/20 dark:bg-blue-600/30 text-blue-700 dark:text-blue-300 active:bg-blue-500/40 dark:active:bg-blue-600/50 touch-manipulation transition-colors"
            >
              ^{label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
