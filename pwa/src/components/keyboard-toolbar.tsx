import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronFirst,
  ChevronLast,
  ChevronsDown,
  ChevronsUp,
  Clipboard,
  Clock,
  CornerDownLeft,
  Delete,
  Expand,
  History,
  ImagePlus,
  Keyboard,
  Languages,
  Minimize2,
  Send,
  X,
  Zap,
} from 'lucide-react'
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useHaptic } from '../hooks/use-haptic'
import {
  type QuickActionHandlers,
  QuickActionsSheet,
} from './quick-actions-menu'
import { FOCUS_RING } from './ui/button'

interface Props {
  onKey: (key: string) => void
  onCtrlKey: (key: string) => void
  onShiftKey?: (key: string) => void
  onCtrlShiftKey?: (key: string) => void
  onScroll?: (direction: 'up' | 'down', pages?: boolean) => void
  onTmuxCopy?: () => void
  // Hide the tmux copy-mode key (backend without copy mode)
  showTmuxCopy?: boolean
  onPaste?: () => void
  // Adds an Attach image key next to Paste (the server takes uploads)
  onAttachImage?: () => void
  onToggleKeyboard?: () => void
  onSendText?: (text: string) => void
  ctrlActive?: boolean
  onCtrlChange?: (active: boolean) => void
  shiftActive?: boolean
  onShiftChange?: (active: boolean) => void
  imeMode?: boolean
  onImeModeChange?: (active: boolean) => void
  defaultExpanded?: boolean
  onHistoryToggle?: () => void
  historyOpen?: boolean
  // Adds a Quick actions key that opens a sheet of common actions
  quickActions?: QuickActionHandlers
  // View-only session: no input controls at all
  readOnly?: boolean
}

interface KeyConfig {
  label: ReactNode
  key: string
  isCtrlModifier?: boolean
  isShiftModifier?: boolean
  isScroll?: boolean
  scrollDir?: 'up' | 'down'
  isTmuxCopy?: boolean
  isPaste?: boolean
  isAttach?: boolean
  isKeyboardToggle?: boolean
  isImeToggle?: boolean
  isExpandToggle?: boolean
  isHistoryToggle?: boolean
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
  {
    label: <Clock size={ICON_SIZE} />,
    key: 'HistoryToggle',
    isHistoryToggle: true,
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
    label: <Clipboard size={ICON_SIZE} />,
    key: 'TmuxPaste',
    isPaste: true,
  },
  { label: <ImagePlus size={ICON_SIZE} />, key: 'Attach', isAttach: true },
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

// Keycap: the one look every toolbar key shares. Neutral is the base; the
// terminal and native styles override a few properties. A light native key is
// white on a white toolbar, so it carries an inset hairline as well: inset,
// because the key rows scroll and a scroller clips anything drawn outside.
const KEYCAP =
  'flex h-11 min-w-11 shrink-0 items-center justify-center rounded-control border border-border bg-surface-raised px-3 text-[13px] font-medium text-fg touch-manipulation select-none transition duration-(--duration-fast) ease-standard hover:border-border-strong active:bg-surface disabled:opacity-50 ' +
  'ui-terminal:bg-bg ui-terminal:font-label ui-terminal:text-[12px] ' +
  'ui-native:border-0 ui-native:text-[15px] ui-native:shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1),0_1px_0_rgb(0_0_0/0.18)] dark:ui-native:shadow-[0_1px_0_rgb(0_0_0/0.8)] active:ui-native:scale-95 ' +
  FOCUS_RING
// Pressed state (Ctrl/Shift/History on)
const KEYCAP_ON = 'bg-accent! text-accent-fg! border-accent!'
// Ctrl+ combos while Ctrl is on
const KEYCAP_COMBO =
  'bg-accent-soft! text-accent! border-transparent! px-2 font-label'

interface KeycapProps extends ComponentProps<'button'> {
  // Set for keys that toggle (exposed as aria-pressed)
  pressed?: boolean
  // The keyboard toggle must let the touch through so the OS keyboard opens
  allowFocus?: boolean
}

// Every key stops the default of mousedown/touchstart so a tap does not move
// focus away from the terminal.
function Keycap({
  pressed,
  allowFocus = false,
  className = '',
  ...props
}: KeycapProps) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onMouseDown={(e) => !allowFocus && e.preventDefault()}
      onTouchStart={(e) =>
        /* v8 ignore next */
        !allowFocus && e.preventDefault()
      }
      onContextMenu={(e) => e.preventDefault()}
      className={`${KEYCAP} ${pressed ? KEYCAP_ON : ''} ${className}`}
      {...props}
    />
  )
}

// A labelled group of keys in the expanded toolbar
function KeyGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset aria-label={label} className="m-0 min-w-0 border-0 p-0">
      <div
        aria-hidden="true"
        className="px-1 pb-1 pt-2 text-[10px] uppercase tracking-wider text-fg-subtle font-label"
      >
        {label}
      </div>
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {children}
      </div>
    </fieldset>
  )
}

const ROOT_CLASS =
  'border-t border-border bg-surface pb-safe ui-terminal:bg-bg ui-native:border-t-0'

export function KeyboardToolbar({
  onKey,
  onCtrlKey,
  onShiftKey,
  onCtrlShiftKey,
  onScroll,
  onTmuxCopy,
  showTmuxCopy = true,
  onPaste,
  onAttachImage,
  onToggleKeyboard,
  onSendText,
  ctrlActive: externalCtrlActive,
  onCtrlChange,
  shiftActive: externalShiftActive,
  onShiftChange,
  imeMode: externalImeMode,
  onImeModeChange,
  defaultExpanded = false,
  onHistoryToggle,
  historyOpen,
  quickActions,
  readOnly = false,
}: Props) {
  const [quickOpen, setQuickOpen] = useState(false)
  const [internalCtrlActive, setInternalCtrlActive] = useState(false)
  const [internalShiftActive, setInternalShiftActive] = useState(false)
  const [expanded, setExpanded] = useState(defaultExpanded)
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

  // Keys of the main row (before the Quick actions / expand keys) and the
  // utility keys, filtered by the handlers and capabilities available
  const baseKeys = useMemo(() => {
    let keys = onSendText
      ? MINIMAL_KEYS
      : MINIMAL_KEYS.filter((k) => !k.isImeToggle)
    // Only show history toggle if handler provided
    if (!onHistoryToggle) {
      keys = keys.filter((k) => !k.isHistoryToggle)
    }
    return keys
  }, [onSendText, onHistoryToggle])
  const utilityKeys = useMemo(
    () =>
      UTILITY_KEYS.filter(
        (k) =>
          (showTmuxCopy || !k.isTmuxCopy) && (!!onAttachImage || !k.isAttach),
      ),
    [showTmuxCopy, onAttachImage],
  )

  const setCtrlActive = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      const newValue = typeof value === 'function' ? value(ctrlActive) : value
      setInternalCtrlActive(newValue)
      onCtrlChange?.(newValue)
    },
    [ctrlActive, onCtrlChange],
  )

  const setShiftActive = useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      const newValue = typeof value === 'function' ? value(shiftActive) : value
      setInternalShiftActive(newValue)
      onShiftChange?.(newValue)
    },
    [shiftActive, onShiftChange],
  )

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
        isPaste?: boolean
        isAttach?: boolean
        isKeyboardToggle?: boolean
        isImeToggle?: boolean
        isHistoryToggle?: boolean
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
      if (opts?.isHistoryToggle && onHistoryToggle) {
        onHistoryToggle()
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
      if (opts?.isPaste && onPaste) {
        onPaste()
        return
      }
      if (opts?.isAttach && onAttachImage) {
        onAttachImage()
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
      onPaste,
      onAttachImage,
      onToggleKeyboard,
      onHistoryToggle,
      toggleImeMode,
      toggleExpanded,
      haptic,
      setShiftActive,
      setCtrlActive,
    ],
  )

  if (readOnly) return null

  // IME input mode - full width text input for Vietnamese/CJK
  if (imeMode) {
    return (
      <div
        className={`flex items-center gap-2 px-3 py-2 ${ROOT_CLASS}`}
        style={{
          paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.5rem)',
        }}
      >
        <button
          onClick={toggleImeMode}
          // `!`: the colour must beat KEYCAP's text-fg, whatever the CSS order
          className={`${KEYCAP} text-danger!`}
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
          placeholder="Type non-Latin text here... (Vietnamese, CJK, ...)"
          className={`h-11 flex-1 rounded-control border border-border bg-surface-raised px-4 text-fg placeholder:text-fg-subtle ui-native:border-0 ${FOCUS_RING}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button
          onClick={handleImeSend}
          disabled={!imeText.trim()}
          className={`${KEYCAP} ${KEYCAP_ON}`}
          aria-label="Send text"
        >
          <Send size={ICON_SIZE} />
        </button>
      </div>
    )
  }

  const renderKey = (keyConfig: KeyConfig) => (
    <Keycap
      key={keyConfig.key}
      data-key={keyConfig.key}
      allowFocus={keyConfig.isKeyboardToggle}
      pressed={
        keyConfig.isCtrlModifier
          ? ctrlActive
          : keyConfig.isShiftModifier
            ? shiftActive
            : keyConfig.isHistoryToggle
              ? !!historyOpen
              : undefined
      }
      onClick={() =>
        handleKey(keyConfig.key, {
          isCtrlModifier: keyConfig.isCtrlModifier,
          isShiftModifier: keyConfig.isShiftModifier,
          isExpandToggle: keyConfig.isExpandToggle,
          scrollDir: keyConfig.scrollDir,
          isTmuxCopy: keyConfig.isTmuxCopy,
          isPaste: keyConfig.isPaste,
          isAttach: keyConfig.isAttach,
          isKeyboardToggle: keyConfig.isKeyboardToggle,
          isImeToggle: keyConfig.isImeToggle,
          isHistoryToggle: keyConfig.isHistoryToggle,
        })
      }
      aria-label={
        keyConfig.isExpandToggle
          ? expanded
            ? 'Collapse keyboard'
            : 'Expand keyboard'
          : keyConfig.isAttach
            ? 'Attach image'
            : undefined
      }
    >
      {keyConfig.isExpandToggle ? (
        expanded ? (
          <Minimize2 size={ICON_SIZE} />
        ) : (
          <Expand size={ICON_SIZE} />
        )
      ) : (
        keyConfig.label
      )}
    </Keycap>
  )

  const renderCombos = (
    combos: { label: string; combo: string }[],
    prefix: string,
  ) =>
    combos.map(({ label, combo }) => (
      <Keycap
        key={combo}
        onClick={() => handleKey(combo)}
        className={KEYCAP_COMBO}
      >
        {prefix}
        {label}
      </Keycap>
    ))

  return (
    <div
      className={`relative flex flex-col px-3 py-2 ${ROOT_CLASS}`}
      style={{ paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 0.5rem)' }}
    >
      {expanded && (
        <>
          <KeyGroup label="Navigate">{EXTRA_KEYS.map(renderKey)}</KeyGroup>
          <KeyGroup label={showTmuxCopy ? 'Scroll · copy mode' : 'Scroll'}>
            {utilityKeys.map(renderKey)}
          </KeyGroup>
          {/* Only while Ctrl is on; Ctrl+Shift shows its own combos inline.
              It floats above the toolbar instead of taking a row: a row that
              comes and goes with Ctrl would resize the terminal (and make the
              running TUI redraw) on every Ctrl press. */}
          {ctrlActive && !shiftActive && (
            <div
              data-testid="ctrl-combos-overlay"
              className="absolute inset-x-0 bottom-full z-10 border-t border-border bg-surface px-3 shadow-lg ui-terminal:bg-bg"
            >
              <KeyGroup label="Ctrl +">
                {renderCombos(CTRL_COMBOS_FULL, '^')}
              </KeyGroup>
            </div>
          )}
        </>
      )}

      {/* A horizontal scroller clips vertically too: the native keycap's 1px
          bottom shadow needs room below it. Only there, so the other styles
          keep their height (the terminal would resize). */}
      <div className="flex items-center gap-2 overflow-x-auto ui-native:pb-0.5">
        {baseKeys.map(renderKey)}
        {quickActions && (
          <Keycap
            data-key="QuickActions"
            aria-label="Quick actions"
            aria-haspopup="dialog"
            onClick={() => {
              haptic('light')
              setQuickOpen(true)
            }}
          >
            <Zap size={ICON_SIZE} />
          </Keycap>
        )}
        {renderKey(EXPAND_TOGGLE_KEY)}
        {!expanded && utilityKeys.map(renderKey)}

        {/* Ctrl+Shift combos */}
        {ctrlActive && shiftActive && (
          <div className="flex shrink-0 gap-1 border-l border-border pl-2 ml-1">
            {renderCombos(CTRL_SHIFT_COMBOS, '^⇧')}
          </div>
        )}

        {/* Ctrl only combos: inline when collapsed, own row when expanded */}
        {ctrlActive && !shiftActive && !expanded && (
          <div className="flex shrink-0 gap-1 border-l border-border pl-2 ml-1">
            {renderCombos(CTRL_COMBOS_MINIMAL, '^')}
          </div>
        )}
      </div>

      {quickActions && (
        <QuickActionsSheet
          isOpen={quickOpen}
          onClose={() => setQuickOpen(false)}
          {...quickActions}
        />
      )}
    </div>
  )
}
