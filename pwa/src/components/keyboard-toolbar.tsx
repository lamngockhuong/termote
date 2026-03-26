import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronFirst,
  ChevronLast,
  ChevronsDown,
  ChevronsUp,
  CornerDownLeft,
  Delete,
  Expand,
  History,
  Keyboard,
  Languages,
  Minimize2,
  Send,
  X,
} from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useHaptic } from '../hooks/use-haptic'

interface Props {
  onKey: (key: string) => void
  onCtrlKey: (key: string) => void
  onShiftKey?: (key: string) => void
  onCtrlShiftKey?: (key: string) => void
  onScroll?: (direction: 'up' | 'down', pages?: boolean) => void
  onTmuxCopy?: () => void
  onToggleKeyboard?: () => void
  onSendText?: (text: string) => void
  ctrlActive?: boolean
  onCtrlChange?: (active: boolean) => void
  shiftActive?: boolean
  onShiftChange?: (active: boolean) => void
  imeMode?: boolean
  onImeModeChange?: (active: boolean) => void
}

interface KeyConfig {
  label: ReactNode
  key: string
  isCtrlModifier?: boolean
  isShiftModifier?: boolean
  isScroll?: boolean
  scrollDir?: 'up' | 'down'
  isTmuxCopy?: boolean
  isKeyboardToggle?: boolean
  isImeToggle?: boolean
  isExpandToggle?: boolean
}

const ICON_SIZE = 18

// Minimal mode keys (essential for terminal use)
const MINIMAL_KEYS: KeyConfig[] = [
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
  { label: 'Ctrl', key: 'Control', isCtrlModifier: true },
  { label: 'Shift', key: 'Shift', isShiftModifier: true },
  { label: <ArrowUp size={ICON_SIZE} />, key: 'ArrowUp' },
  { label: <ArrowDown size={ICON_SIZE} />, key: 'ArrowDown' },
  { label: <ArrowLeft size={ICON_SIZE} />, key: 'ArrowLeft' },
  { label: <ArrowRight size={ICON_SIZE} />, key: 'ArrowRight' },
]

// Extra keys for full mode
const EXTRA_KEYS: KeyConfig[] = [
  { label: <ChevronFirst size={ICON_SIZE} />, key: 'Home' },
  { label: <ChevronLast size={ICON_SIZE} />, key: 'End' },
  { label: <Delete size={ICON_SIZE} />, key: 'Delete' },
  { label: 'Bksp', key: 'Backspace' },
  { label: 'PgUp', key: 'PageUp' },
  { label: 'PgDn', key: 'PageDown' },
  { label: 'Ins', key: 'Insert' },
]

// Utility keys (always at end)
const UTILITY_KEYS: KeyConfig[] = [
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

// Expand/collapse toggle key (position: after arrow/extra keys, before utility keys)
const EXPAND_TOGGLE_KEY: KeyConfig = {
  label: <Expand size={ICON_SIZE} />,
  key: 'Expand',
  isExpandToggle: true,
}

// Minimal Ctrl combos (most used)
const CTRL_COMBOS_MINIMAL = [
  { label: 'C', combo: 'c' },
  { label: 'D', combo: 'd' },
  { label: 'Z', combo: 'z' },
  { label: 'L', combo: 'l' },
  { label: 'A', combo: 'a' },
  { label: 'E', combo: 'e' },
]

// Extra Ctrl combos for full mode
const CTRL_COMBOS_EXTRA = [
  { label: 'B', combo: 'b' },
  { label: 'X', combo: 'x' },
  { label: 'K', combo: 'k' },
  { label: 'U', combo: 'u' },
  { label: 'W', combo: 'w' },
  { label: 'R', combo: 'r' },
  { label: 'P', combo: 'p' },
  { label: 'N', combo: 'n' },
]

// Pre-computed full Ctrl combos to avoid spread on render
const CTRL_COMBOS_FULL = [...CTRL_COMBOS_MINIMAL, ...CTRL_COMBOS_EXTRA]

const CTRL_SHIFT_COMBOS = [
  { label: 'C', combo: 'c' },
  { label: 'V', combo: 'v' },
  { label: 'Z', combo: 'z' },
  { label: 'X', combo: 'x' },
]

// Button background color based on key type
function getKeyButtonBg(
  key: KeyConfig,
  ctrlActive: boolean,
  shiftActive: boolean,
): string {
  if (key.isCtrlModifier && ctrlActive) return 'bg-blue-600 text-white'
  if (key.isShiftModifier && shiftActive) return 'bg-orange-500 text-white'
  if (key.isExpandToggle) return 'bg-indigo-200/70 dark:bg-indigo-700/50'
  if (key.isImeToggle) return 'bg-teal-200/70 dark:bg-teal-700/50'
  if (key.isKeyboardToggle) return 'bg-purple-200/70 dark:bg-purple-700/50'
  if (key.isTmuxCopy) return 'bg-amber-200/70 dark:bg-amber-700/50'
  if (key.isScroll) return 'bg-green-200/70 dark:bg-green-800/50'
  return 'bg-zinc-200/70 dark:bg-zinc-700/70'
}

export function KeyboardToolbar({
  onKey,
  onCtrlKey,
  onShiftKey,
  onCtrlShiftKey,
  onScroll,
  onTmuxCopy,
  onToggleKeyboard,
  onSendText,
  ctrlActive: externalCtrlActive,
  onCtrlChange,
  shiftActive: externalShiftActive,
  onShiftChange,
  imeMode: externalImeMode,
  onImeModeChange,
}: Props) {
  const [internalCtrlActive, setInternalCtrlActive] = useState(false)
  const [internalShiftActive, setInternalShiftActive] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [internalImeMode, setInternalImeMode] = useState(false)
  const imeMode = externalImeMode ?? internalImeMode
  const [imeText, setImeText] = useState('')
  const imeInputRef = useRef<HTMLInputElement>(null)
  const imeFocusTimeoutRef = useRef<number | null>(null)
  const ctrlActive = externalCtrlActive ?? internalCtrlActive
  const shiftActive = externalShiftActive ?? internalShiftActive
  const { trigger: haptic } = useHaptic()

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (imeFocusTimeoutRef.current) clearTimeout(imeFocusTimeoutRef.current)
    }
  }, [])

  // Build visible keys based on mode (memoized to avoid re-creating arrays)
  const visibleKeys = useMemo(() => {
    const baseKeys = onSendText
      ? MINIMAL_KEYS
      : MINIMAL_KEYS.filter((k) => !k.isImeToggle)
    return expanded
      ? [...baseKeys, ...EXTRA_KEYS, EXPAND_TOGGLE_KEY, ...UTILITY_KEYS]
      : [...baseKeys, EXPAND_TOGGLE_KEY, ...UTILITY_KEYS]
  }, [expanded, onSendText])

  // Ctrl combos based on mode
  const ctrlCombos = expanded ? CTRL_COMBOS_FULL : CTRL_COMBOS_MINIMAL

  const setCtrlActive = (value: boolean | ((prev: boolean) => boolean)) => {
    const newValue = typeof value === 'function' ? value(ctrlActive) : value
    setInternalCtrlActive(newValue)
    onCtrlChange?.(newValue)
  }

  const setShiftActive = (value: boolean | ((prev: boolean) => boolean)) => {
    const newValue = typeof value === 'function' ? value(shiftActive) : value
    setInternalShiftActive(newValue)
    onShiftChange?.(newValue)
  }

  const setImeMode = useCallback(
    (value: boolean) => {
      setInternalImeMode(value)
      onImeModeChange?.(value)
    },
    [onImeModeChange],
  )

  const toggleImeMode = useCallback(() => {
    haptic('medium')
    const next = !imeMode
    setImeMode(next)
    if (next) {
      imeFocusTimeoutRef.current = window.setTimeout(
        () => imeInputRef.current?.focus(),
        50,
      )
    }
    setImeText('')
  }, [haptic, imeMode, setImeMode])

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

  const toggleExpanded = useCallback(() => {
    haptic('medium')
    setExpanded((prev) => !prev)
  }, [haptic])

  const handleKey = useCallback(
    (
      key: string,
      opts?: {
        isCtrlModifier?: boolean
        isShiftModifier?: boolean
        isExpandToggle?: boolean
        scrollDir?: 'up' | 'down'
        isTmuxCopy?: boolean
        isKeyboardToggle?: boolean
        isImeToggle?: boolean
      },
    ) => {
      haptic('light')
      if (opts?.isExpandToggle) {
        toggleExpanded()
        return
      }
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
      if (opts?.isCtrlModifier) {
        setCtrlActive((prev) => !prev)
        return
      }
      if (opts?.isShiftModifier) {
        setShiftActive((prev) => !prev)
        return
      }
      // Escape clears active modifiers instead of sending Escape key
      if (key === 'Escape' && (ctrlActive || shiftActive)) {
        setCtrlActive(false)
        setShiftActive(false)
        return
      }
      // Handle key with modifiers
      // Only lowercase single letters, preserve special key names (Tab, ArrowUp, etc.)
      const keyToSend = /^[a-z]$/i.test(key) ? key.toLowerCase() : key
      if (ctrlActive && shiftActive) {
        onCtrlShiftKey?.(keyToSend)
        setCtrlActive(false)
        setShiftActive(false)
      } else if (ctrlActive) {
        onCtrlKey(keyToSend)
        setCtrlActive(false)
      } else if (shiftActive) {
        onShiftKey?.(keyToSend)
        setShiftActive(false)
      } else {
        onKey(key)
      }
    },
    [
      ctrlActive,
      shiftActive,
      onKey,
      onCtrlKey,
      onShiftKey,
      onCtrlShiftKey,
      onScroll,
      onTmuxCopy,
      onToggleKeyboard,
      toggleImeMode,
      toggleExpanded,
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
              isCtrlModifier: keyConfig.isCtrlModifier,
              isShiftModifier: keyConfig.isShiftModifier,
              isExpandToggle: keyConfig.isExpandToggle,
              scrollDir: keyConfig.scrollDir,
              isTmuxCopy: keyConfig.isTmuxCopy,
              isKeyboardToggle: keyConfig.isKeyboardToggle,
              isImeToggle: keyConfig.isImeToggle,
            })
          }
          className={`min-w-11 h-11 px-3 flex items-center justify-center rounded-xl text-sm font-mono ${getKeyButtonBg(keyConfig, ctrlActive, shiftActive)} active:bg-zinc-300 dark:active:bg-zinc-600 touch-manipulation transition-colors`}
          aria-label={
            keyConfig.isExpandToggle
              ? expanded
                ? 'Collapse keyboard'
                : 'Expand keyboard'
              : undefined
          }
        >
          {keyConfig.isExpandToggle
            ? expanded
              ? <Minimize2 size={ICON_SIZE} />
              : <Expand size={ICON_SIZE} />
            : keyConfig.label}
        </button>
      ))}

      {/* Ctrl+Shift combos */}
      {ctrlActive && shiftActive && (
        <div className="flex gap-1 ml-1 pl-2 border-l border-zinc-300 dark:border-zinc-600">
          {CTRL_SHIFT_COMBOS.map(({ label, combo }) => (
            <button
              key={combo}
              onMouseDown={(e) => e.preventDefault()}
              onTouchStart={(e) => e.preventDefault()}
              onContextMenu={(e) => e.preventDefault()}
              onClick={() => handleKey(combo)}
              className="min-w-11 h-11 px-2 flex items-center justify-center rounded-xl text-sm font-mono bg-gradient-to-r from-blue-500/30 to-orange-500/30 dark:from-blue-600/40 dark:to-orange-600/40 text-purple-700 dark:text-purple-300 active:from-blue-500/50 active:to-orange-500/50 touch-manipulation transition-colors"
            >
              ^⇧{label}
            </button>
          ))}
        </div>
      )}

      {/* Ctrl only combos */}
      {ctrlActive && !shiftActive && (
        <div className="flex gap-1 ml-1 pl-2 border-l border-zinc-300 dark:border-zinc-600">
          {ctrlCombos.map(({ label, combo }) => (
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
