import { Lock } from 'lucide-react'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { splitPath } from '../utils/files-format'
import { FOCUS_RING } from './ui/button'

// Letters as git status writes them, and what a screen reader says
export const STATUS: Record<string, MessageKey> = {
  M: 'files.status.modified',
  A: 'files.status.added',
  D: 'files.status.deleted',
  R: 'files.status.renamed',
  C: 'files.status.copied',
  T: 'files.status.typeChanged',
  U: 'files.status.conflict',
  '?': 'files.status.untracked',
}

// The colour of a status letter; any other is text-info
export const TONE: Record<string, string> = {
  A: 'text-success',
  '?': 'text-success',
  D: 'text-danger',
  U: 'text-warning',
}

// One changed file of a list (Changes, or a commit's files): its status
// letter, name, directory (a rename's source first) and a lock on a name
// that may hold secrets. className adds to the button's own.
export function ChangeRowButton({
  code,
  path,
  orig,
  sensitive,
  onOpen,
  className = '',
}: {
  code: string
  path: string
  orig?: string
  sensitive: boolean
  onOpen: () => void
  className?: string
}) {
  const [dir, name] = splitPath(path)
  const { t } = useT()
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex min-h-9 min-w-0 items-center gap-2 px-3 text-left text-[13px] pointer-coarse:min-h-touch ${FOCUS_RING} focus-visible:-outline-offset-2 ${className}`}
    >
      <span
        aria-hidden="true"
        className={`w-3 shrink-0 font-term font-semibold ${TONE[code] ?? 'text-info'}`}
      >
        {code}
      </span>
      <span className="sr-only">{STATUS[code] ? t(STATUS[code]) : code}: </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
        <span className="shrink-0 font-medium text-fg">{name}</span>
        <span className="truncate text-[12px] text-fg-subtle">
          {orig ? `${orig} → ` : ''}
          {dir}
        </span>
      </span>
      {sensitive && (
        <span
          className="flex shrink-0 items-center text-warning"
          title={t('files.status.sensitiveTitle')}
        >
          <Lock size={12} aria-hidden="true" />
          <span className="sr-only">{t('files.status.sensitive')}</span>
        </span>
      )}
    </button>
  )
}
