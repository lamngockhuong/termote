import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  CornerDownLeft,
  History,
  Keyboard,
  Languages,
  Send,
  X,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useHaptic } from '../hooks/use-haptic'

interface Props {
  onKey: (key: string) => void
  onCtrlKey: (key: string) => void
  onScroll?: (direction: 'up' | 'down', pages?: boolean) => void
  onTmuxCopy?: () => void
  onToggleKeyboard?: () => void
  onSendText?: (text: string) => void
  ctrlActive?: boolean
  onCtrlChange?: (active: boolean) => void
}

interface KeyConfig {
  label: ReactNode
  key: string
  isModifier?: boolean
  isScroll?: boolean
  scrollDir?: 'up' | 'down'
  isTmuxCopy?: boolean
  isKeyboardToggle?: boolean
  isImeToggle?: boolean
}

const ICON_SIZE = 18

const KEYS: KeyConfig[] = [
  {
    label: <Keyboard size={ICON_SIZE} />,
    key: 'Keyboard',
    isKeyboardToggle: true,
  },
  {
    label: <Languages size={ICON_SIZE} />,
    key: 'ImeToggle',
    isImeToggle: true,
  },
  { label: 'Tab', key: 'Tab' },
  { label: 'Esc', key: 'Escape' },
  { label: <CornerDownLeft size={ICON_SIZE} />, key: 'Enter' },
  { label: 'Ctrl', key: 'Control', isModifier: true },
  { label: <ArrowUp size={ICON_SIZE} />, key: 'ArrowUp' },
  { label: <ArrowDown size={ICON_SIZE} />, key: 'ArrowDown' },
  { label: <ArrowLeft size={ICON_SIZE} />, key: 'ArrowLeft' },
  { label: <ArrowRight size={ICON_SIZE} />, key: 'ArrowRight' },
  { label: <History size={ICON_SIZE} />, key: 'TmuxCopy', isTmuxCopy: true },
  {
    label: <ChevronsUp size={ICON_SIZE} />,
    key: 'ScrollUp',
    isScroll: true,
    scrollDir: 'up',
  },
  {
    label: <ChevronsDown size={ICON_SIZE} />,
    key: 'ScrollDown',
    isScroll: true,
    scrollDir: 'down',
  },
]

const CTRL_COMBOS = [
  { label: 'B', combo: 'b' },
  { label: 'C', combo: 'c' },
  { label: 'D', combo: 'd' },
  { label: 'X', combo: 'x' },
  { label: 'Z', combo: 'z' },
  { label: 'L', combo: 'l' },
  { label: 'A', combo: 'a' },
  { label: 'E', combo: 'e' },
]

// Button background color based on key type
function getKeyButtonBg(key: KeyConfig, ctrlActive: boolean): string {
  if (key.isModifier && ctrlActive) return 'bg-blue-600 text-white'
  if (key.isImeToggle) return 'bg-teal-200/70 dark:bg-teal-700/50'
  if (key.isKeyboardToggle) return 'bg-purple-200/70 dark:bg-purple-700/50'
  if (key.isTmuxCopy) return 'bg-amber-200/70 dark:bg-amber-700/50'
  if (key.isScroll) return 'bg-green-200/70 dark:bg-green-800/50'
  return 'bg-zinc-200/70 dark:bg-zinc-700/70'
}

export function KeyboardToolbar({
  onKey,
  onCtrlKey,
  onScroll,
  onTmuxCopy,
  onToggleKeyboard,
  onSendText,
  ctrlActive: externalCtrlActive,
  onCtrlChange,
}: Props) {
  const [internalCtrlActive, setInternalCtrlActive] = useState(false)
  const [imeMode, setImeMode] = useState(false)
  const [imeText, setImeText] = useState('')
  const imeInputRef = useRef<HTMLInputElement>(null)
  const imeFocusTimeoutRef = useRef<number | null>(null)
  const ctrlActive = externalCtrlActive ?? internalCtrlActive
  const { trigger: haptic } = useHaptic()

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (imeFocusTimeoutRef.current) clearTimeout(imeFocusTimeoutRef.current)
    }
  }, [])

  // Filter out IME toggle if handler not provided
  const visibleKeys = onSendText ? KEYS : KEYS.filter((k) => !k.isImeToggle)

  const setCtrlActive = (value: boolean | ((prev: boolean) => boolean)) => {
    const newValue = typeof value === 'function' ? value(ctrlActive) : value
    setInternalCtrlActive(newValue)
    onCtrlChange?.(newValue)
  }

  const toggleImeMode = useCallback(() => {
    haptic('medium')
    setImeMode((prev) => {
      const next = !prev
      if (next) {
        imeFocusTimeoutRef.current = window.setTimeout(
          () => imeInputRef.current?.focus(),
          50,
        )
      }
      return next
    })
    setImeText('')
  }, [haptic])

  const handleImeSend = useCallback(() => {
    if (imeText.trim() && onSendText) {
      haptic('light')
      onSendText(imeText)
      setImeText('')
      imeInputRef.current?.focus()
    }
  }, [imeText, onSendText, haptic])

  const handleImeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault()
        handleImeSend()
      }
    },
    [handleImeSend],
  )

  const handleKey = useCallback(
    (
      key: string,
      opts?: {
        isModifier?: boolean
        scrollDir?: 'up' | 'down'
        isTmuxCopy?: boolean
        isKeyboardToggle?: boolean
        isImeToggle?: boolean
      },
    ) => {
      haptic('light')
      if (opts?.isImeToggle) {
        toggleImeMode()
        return
      }
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
    [
      ctrlActive,
      onKey,
      onCtrlKey,
      onScroll,
      onTmuxCopy,
      onToggleKeyboard,
      toggleImeMode,
      haptic,
    ],
  )

  // IME input mode - full width text input for Vietnamese/CJK
  if (imeMode) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-2 pb-safe glass-surface border-t border-zinc-300/30 dark:border-zinc-700/30"
        style={{
          paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.5rem)',
        }}
      >
        <button
          onClick={toggleImeMode}
          className="min-w-11 h-11 px-3 flex items-center justify-center rounded-xl text-sm font-mono bg-red-200/70 dark:bg-red-700/50 active:bg-red-300 dark:active:bg-red-600 touch-manipulation transition-colors"
          aria-label="Close IME input"
        >
          <X size={ICON_SIZE} />
        </button>
        <input
          ref={imeInputRef}
          type="text"
          value={imeText}
          onChange={(e) => setImeText(e.target.value)}
          onKeyDown={handleImeKeyDown}
          placeholder="Gõ tiếng Việt..."
          className="flex-1 h-11 px-4 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-white placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button
          onClick={handleImeSend}
          disabled={!imeText.trim()}
          className="min-w-11 h-11 px-3 flex items-center justify-center rounded-xl text-sm font-mono bg-blue-500 dark:bg-blue-600 text-white disabled:opacity-50 disabled:cursor-not-allowed active:bg-blue-600 dark:active:bg-blue-700 touch-manipulation transition-colors"
          aria-label="Send text"
        >
          <Send size={ICON_SIZE} />
        </button>
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 pb-safe glass-surface border-t border-zinc-300/30 dark:border-zinc-700/30 overflow-x-auto"
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.5rem)' }}
    >
      {visibleKeys.map((keyConfig) => (
        <button
          key={keyConfig.key}
          onMouseDown={(e) => !keyConfig.isKeyboardToggle && e.preventDefault()}
          onTouchStart={(e) =>
            !keyConfig.isKeyboardToggle && e.preventDefault()
          }
          onContextMenu={(e) => e.preventDefault()}
          onClick={() =>
            handleKey(keyConfig.key, {
              isModifier: keyConfig.isModifier,
              scrollDir: keyConfig.scrollDir,
              isTmuxCopy: keyConfig.isTmuxCopy,
              isKeyboardToggle: keyConfig.isKeyboardToggle,
              isImeToggle: keyConfig.isImeToggle,
            })
          }
          className={`min-w-11 h-11 px-3 flex items-center justify-center rounded-xl text-sm font-mono ${getKeyButtonBg(keyConfig, ctrlActive)} active:bg-zinc-300 dark:active:bg-zinc-600 touch-manipulation transition-colors`}
        >
          {keyConfig.label}
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
