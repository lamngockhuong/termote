import { Search, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef } from 'react'
import { useT } from '../i18n/i18n-context'
import { IconButton } from './ui/button'

interface FieldProps {
  id: string
  // Accessible name and placeholder ("Find a session")
  label: string
  value: string
  onChange: (value: string) => void
  // Esc on an empty box, or its clear button on an empty box
  onClose: () => void
  // Enter: open the first match
  onSubmit: () => void
  // ArrowDown: move to the first match
  onArrowDown: () => void
  // Take focus on mounting: false when the box comes back with the
  // sidebar expanded again, rather than from its toggle
  autoFocus?: boolean
}

// A search box opened from its toggle: it takes focus when it appears, so a
// sheet opening never raises a phone's keyboard by itself. Esc clears it,
// then closes it; preventDefault keeps the same Esc from closing the sheet
// (a <dialog> cancel) or the overview (which skips handled keys). Keys that
// end an IME composition belong to the IME.
export function SessionSearchField({
  id,
  label,
  value,
  onChange,
  onClose,
  onSubmit,
  onArrowDown,
  autoFocus = true,
}: FieldProps) {
  const { t } = useT()
  const input = useRef<HTMLInputElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mounting
  useEffect(() => {
    if (autoFocus) input.current?.focus()
  }, [])

  const onKey = (e: KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      if (value) onChange('')
      else onClose()
    } else if (e.key === 'Enter') onSubmit()
    else if (e.key === 'ArrowDown') onArrowDown()
    else return
    e.preventDefault()
  }

  return (
    <div className="relative">
      <Search
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-subtle"
      />
      <input
        ref={input}
        id={id}
        type="search"
        aria-label={label}
        placeholder={`${label}…`}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        enterKeyHint="go"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        // 16px on a phone: iOS zooms the page into a smaller field
        className="h-8 w-full min-w-0 rounded-control border border-border bg-bg pr-8 pl-7 text-base text-fg outline-none placeholder:text-fg-subtle focus:border-accent md:text-[13px] pointer-coarse:h-touch [&::-webkit-search-cancel-button]:hidden"
      />
      <IconButton
        size="sm"
        onClick={() => {
          if (value) {
            onChange('')
            input.current?.focus()
          } else onClose()
        }}
        aria-label={value ? t('shell.search.clear') : t('shell.search.close')}
        title={value ? t('shell.search.clearShort') : t('common.close')}
        className="absolute top-1/2 right-0.5 -translate-y-1/2"
      >
        <X size={14} aria-hidden="true" />
      </IconButton>
    </div>
  )
}

interface ToggleProps {
  // The id of the field it opens
  controls: string
  // What it searches, in the app's language ("sessions"): two may show at
  // once on a desktop
  noun: string
  open: boolean
  onToggle: () => void
}

// The magnifier that opens and closes a search box.
export function SearchToggle({ controls, noun, open, onToggle }: ToggleProps) {
  const { t } = useT()
  const label = open
    ? t('shell.search.close')
    : t('shell.search.open', { noun })
  return (
    <IconButton
      onClick={onToggle}
      aria-label={label}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      title={label}
    >
      <Search size={18} aria-hidden="true" />
    </IconButton>
  )
}
