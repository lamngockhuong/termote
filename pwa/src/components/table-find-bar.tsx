import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { KeyboardEvent, RefObject } from 'react'
import type { FindStatus } from '../hooks/use-csv-find'
import { type FindOptions, MAX_FIND } from '../utils/csv-find'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { FOCUS_RING, IconButton } from './ui/button'

export type FindFlags = Omit<FindOptions, 'query'>

interface Props {
  input: string
  onInput: (input: string) => void
  flags: FindFlags
  onFlags: (flags: FindFlags) => void
  status: FindStatus
  // Matches found (MAX_FIND + 1: more), and the place of the current one
  count: number
  current: number
  // Columns hidden, which are not searched
  hidden: number
  // To the next match (1) or the previous one (-1)
  onStep: (step: 1 | -1) => void
  // Escape, or the close button
  onClose: () => void
  inputRef: RefObject<HTMLInputElement | null>
}

const TOGGLES: { flag: keyof FindFlags; label: string; text: string }[] = [
  { flag: 'matchCase', label: 'Match case', text: 'Aa' },
  { flag: 'wholeCell', label: 'Whole cell', text: 'ab' },
  { flag: 'regex', label: 'Regular expression', text: '.*' },
]

function statusText(status: FindStatus, count: number, current: number) {
  if (status === 'invalid') return 'Invalid pattern'
  if (status === 'busy') return '…'
  if (status === 'timeout') return 'Search took too long'
  if (status === 'failed') return 'Search failed'
  if (status === 'unavailable') return 'Search is unavailable'
  if (!count) return 'No matches'
  const total = count > MAX_FIND ? `${MAX_FIND}+` : String(count)
  // The one past MAX_FIND can be gone to, never counted
  return `${Math.min(current + 1, MAX_FIND)} of ${total}`
}

// Find in a table, under its bar: what to find, how, and where the current
// match is among them. Only shows them; the table finds and moves.
export function TableFindBar({
  input,
  onInput,
  flags,
  onFlags,
  status,
  count,
  current,
  hidden,
  onStep,
  onClose,
  inputRef,
}: Props) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Escape while composing (IME) drops the word composed, not find
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onClose()
    }
  }
  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // A key that ends a word being composed (IME) is the composer's
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    onStep(e.shiftKey ? -1 : 1)
  }
  const shown = visibleUnsafe(input)
  return (
    <search
      aria-label="Find in table"
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-[13px]"
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={onInputKey}
        placeholder="Find"
        aria-label="Find"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        className={`h-8 min-w-0 flex-1 basis-32 rounded-control border border-border bg-surface px-2 text-fg pointer-coarse:h-touch ${FOCUS_RING}`}
      />
      {TOGGLES.map(({ flag, label, text }) => (
        <IconButton
          key={flag}
          size="sm"
          aria-label={label}
          title={label}
          aria-pressed={flags[flag]}
          onClick={() => onFlags({ ...flags, [flag]: !flags[flag] })}
          className={`font-term text-[12px] ${flags[flag] ? 'text-accent' : ''}`}
        >
          {/* Whole cell: the letters in a box, as a cell */}
          <span
            className={
              flag === 'wholeCell'
                ? 'rounded-sm border border-current px-0.5'
                : ''
            }
          >
            {text}
          </span>
        </IconButton>
      ))}
      <span className="min-w-16 tabular-nums text-fg-muted" aria-live="polite">
        {input && statusText(status, count, current)}
      </span>
      <IconButton
        size="sm"
        aria-label="Previous match"
        title="Previous match (Shift+Enter, Shift+F3)"
        disabled={!count}
        onClick={() => onStep(-1)}
      >
        <ChevronUp size={15} aria-hidden="true" />
      </IconButton>
      <IconButton
        size="sm"
        aria-label="Next match"
        title="Next match (Enter, F3)"
        disabled={!count}
        onClick={() => onStep(1)}
      >
        <ChevronDown size={15} aria-hidden="true" />
      </IconButton>
      <IconButton
        size="sm"
        aria-label="Close find"
        title="Close (Escape)"
        onClick={onClose}
      >
        <X size={15} aria-hidden="true" />
      </IconButton>
      {(hidden > 0 || shown !== input) && (
        <div className="basis-full text-[12px] text-fg-subtle">
          {/* What was typed with its hidden characters shown, as a cell's
              sheet shows a value */}
          {shown !== input && (
            <span className="mr-3 font-term break-all">{shown}</span>
          )}
          {hidden > 0 && 'Hidden columns not searched'}
        </div>
      )}
    </search>
  )
}
