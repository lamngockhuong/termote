import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { KeyboardEvent, RefObject } from 'react'
import type { FindStatus } from '../hooks/use-csv-find'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
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
  // The toggles offered (all, by default) and what the bar finds in
  toggles?: (keyof FindFlags)[]
  label?: string
  // F3 steps too (the table's own key)
  f3?: boolean
}

const TOGGLES: { flag: keyof FindFlags; label: MessageKey; text: string }[] = [
  { flag: 'matchCase', label: 'files.search.matchCase', text: 'Aa' },
  { flag: 'wholeCell', label: 'files.tableFind.wholeCell', text: 'ab' },
  { flag: 'regex', label: 'files.search.regex', text: '.*' },
]

function statusText(
  status: FindStatus,
  count: number,
  current: number,
  t: Translate<MessageKey>,
) {
  if (status === 'invalid') return t('files.tableFind.invalid')
  if (status === 'busy') return '…'
  if (status === 'timeout') return t('files.tableFind.timeout')
  if (status === 'failed') return t('files.tableFind.failed')
  if (status === 'unavailable') return t('files.tableFind.unavailable')
  if (!count) return t('files.search.none')
  const total = count > MAX_FIND ? `${MAX_FIND}+` : String(count)
  // The one past MAX_FIND can be gone to, never counted
  return t('files.tableFind.at', {
    current: Math.min(current + 1, MAX_FIND),
    total,
  })
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
  toggles = ['matchCase', 'wholeCell', 'regex'],
  label,
  f3 = true,
}: Props) {
  const { t } = useT()
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
      aria-label={label ?? t('files.tableFind.label')}
      className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5 text-[13px]"
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        value={input}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={onInputKey}
        placeholder={t('files.pdf.findShort')}
        aria-label={t('files.pdf.findShort')}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        className={`h-8 min-w-0 flex-1 basis-32 rounded-control border border-border bg-surface px-2 text-fg pointer-coarse:h-touch ${FOCUS_RING}`}
      />
      {TOGGLES.filter((toggle) => toggles.includes(toggle.flag)).map(
        ({ flag, label: name, text }) => (
          <IconButton
            key={flag}
            size="sm"
            aria-label={t(name)}
            title={t(name)}
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
        ),
      )}
      <span className="min-w-16 tabular-nums text-fg-muted" aria-live="polite">
        {input && statusText(status, count, current, t)}
      </span>
      <IconButton
        size="sm"
        aria-label={t('files.tableFind.previous')}
        title={t(
          f3
            ? 'files.tableFind.previousTitleF3'
            : 'files.tableFind.previousTitle',
        )}
        disabled={!count}
        onClick={() => onStep(-1)}
      >
        <ChevronUp size={15} aria-hidden="true" />
      </IconButton>
      <IconButton
        size="sm"
        aria-label={t('files.tableFind.next')}
        title={t(
          f3 ? 'files.tableFind.nextTitleF3' : 'files.tableFind.nextTitle',
        )}
        disabled={!count}
        onClick={() => onStep(1)}
      >
        <ChevronDown size={15} aria-hidden="true" />
      </IconButton>
      <IconButton
        size="sm"
        aria-label={t('files.tableFind.close')}
        title={t('files.tableFind.closeTitle')}
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
          {hidden > 0 && t('files.tableFind.hidden')}
        </div>
      )}
    </search>
  )
}
