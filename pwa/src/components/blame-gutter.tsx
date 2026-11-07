import { Copy } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import type { BlameCommit, FileBlame } from '../hooks/use-mux-api'
import type { Locale } from '../i18n'
import { formatDateTime } from '../i18n/format'
import { useT } from '../i18n/i18n-context'
import { copyText } from '../utils/copy-text'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { menuViewport, placeMenu, topLayer } from './ui/menu'

// The blame column's width: author and age, or on a phone initials and age.
// In rem: the column's font is not the code's, so ch would differ.
export const blameWidth = (compact: boolean) => (compact ? '5.5rem' : '11.5rem')

// The commit that last changed each line (index 0 is line 1); '' for a line
// not committed. Lines git did not blame stay ''.
export function lineOwners(blame: FileBlame): string[] {
  const owners: string[] = new Array(blame.lines).fill('')
  for (const r of blame.ranges)
    owners.fill(r.commit as string, r.start - 1, r.start - 1 + r.count)
  return owners
}

// How long ago a commit was, in its largest whole unit up to years; narrow
// ("3 mo. ago") for the column
const AGE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]
export function blameAge(time: number, locale: Locale, now = Date.now()) {
  const diff = time - Math.floor(now / 1000)
  const rtf = new Intl.RelativeTimeFormat(locale, {
    numeric: 'auto',
    style: 'narrow',
  })
  for (const [unit, s] of AGE_UNITS)
    if (Math.abs(diff) >= s) return rtf.format(Math.trunc(diff / s), unit)
  return rtf.format(0, 'minute')
}

// Up to two letters of a name: the first of its first and last words
export function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = [...words[0]][0]
  const last = words.length > 1 ? [...words[words.length - 1]][0] : ''
  return (first + last).toUpperCase()
}

const CELL =
  'flex shrink-0 select-none items-center gap-1 overflow-hidden px-2 text-left font-sans text-[11px] text-fg-subtle'

// One line's blame cell. The first line of a run of one commit names it and
// opens its details; the others are blank, a faint rule above each run.
export function BlameCell({
  owner,
  first,
  line,
  commit,
  compact,
  onOpen,
}: {
  owner: string
  first: boolean
  line: number
  commit?: BlameCommit
  compact: boolean
  onOpen: (hash: string, anchor: HTMLElement) => void
}) {
  const { t, locale } = useT()
  const width = blameWidth(compact)
  const rule = first && line > 1 ? 'border-t border-border/60' : ''
  if (!first)
    return <span aria-hidden="true" className={CELL} style={{ width }} />
  if (!owner || !commit)
    return (
      <span className={`${CELL} ${rule} italic`} style={{ width }}>
        <span className="truncate">{t('files.blame.notCommitted')}</span>
      </span>
    )
  const author = visibleUnsafe(commit.author)
  const age = blameAge(commit.time, locale)
  return (
    <button
      type="button"
      data-blame-commit={owner}
      aria-label={t('files.blame.cellLabel', { author, age, line })}
      onClick={(e) => onOpen(owner, e.currentTarget)}
      className={`${CELL} ${rule} cursor-pointer hover:bg-surface-raised hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
      style={{ width }}
    >
      <span className="min-w-0 flex-1 truncate">
        {compact ? initials(author) : author}
      </span>
      <span className="shrink-0 tabular-nums">{age}</span>
    </button>
  )
}

// A commit's details, anchored to the cell that opened it: in the top layer
// where the browser has one (so the code's scrolling box never cuts it),
// placed in the viewport like a menu. Escape, a press outside or the code
// scrolling close it; focus goes back to the cell after Escape.
export function BlamePopover({
  hash,
  commit,
  anchor,
  notify,
  onClose,
}: {
  hash: string
  commit: BlameCommit
  anchor: HTMLElement
  notify: (msg: string) => void
  onClose: () => void
}) {
  const { t, locale } = useT()
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const inTopLayer = topLayer()

  useLayoutEffect(() => {
    const el = ref.current as HTMLDivElement
    if (inTopLayer) el.showPopover()
    const at = placeMenu(
      anchor.getBoundingClientRect(),
      { width: el.offsetWidth, height: el.offsetHeight },
      'start',
      menuViewport(),
    )
    el.style.left = `${at.left}px`
    el.style.top = `${at.top}px`
    el.style.maxHeight = at.maxHeight === undefined ? '' : `${at.maxHeight}px`
    el.focus({ preventScroll: true })
  }, [anchor, inTopLayer])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!ref.current?.contains(target) && !anchor.contains(target))
        closeRef.current()
    }
    // The code scrolling (or the window resized) moves the cell away from
    // the details; a terminal or a chat scrolling beside it does not
    const frame: EventTarget =
      anchor.closest('[data-scroll-restore]') ?? document
    const close = () => closeRef.current()
    document.addEventListener('pointerdown', onDown)
    frame.addEventListener('scroll', close)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      frame.removeEventListener('scroll', close)
      window.removeEventListener('resize', close)
    }
  }, [anchor])

  const copy = async () => {
    const ok = (await copyText(hash)) === 'ok'
    notify(t(ok ? 'files.blame.hashCopied' : 'files.blame.hashCopyFailed'))
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('files.blame.details')}
      tabIndex={-1}
      popover={inTopLayer ? 'manual' : undefined}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        onClose()
        anchor.focus()
      }}
      data-testid="blame-popover"
      className="fixed inset-auto z-50 m-0 w-72 max-w-[calc(100vw-16px)] overflow-y-auto rounded-panel border border-border bg-surface-raised p-3 font-sans text-[13px] text-fg shadow-xl outline-none"
    >
      <p className="break-words font-medium">
        {visibleUnsafe(commit.summary) || t('files.commit.noMessage')}
      </p>
      <p className="mt-1 text-fg-muted">{visibleUnsafe(commit.author)}</p>
      <p className="text-fg-muted">
        {formatDateTime(commit.time * 1000, locale)}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <code className="font-term text-fg-subtle">{hash.slice(0, 7)}</code>
        <Button size="sm" onClick={copy}>
          <Copy size={14} aria-hidden="true" />
          {t('files.blame.copyHash')}
        </Button>
      </div>
    </div>
  )
}
