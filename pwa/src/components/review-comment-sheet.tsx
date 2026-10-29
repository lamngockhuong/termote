import { type KeyboardEvent, type RefObject, useRef, useState } from 'react'
import { useT } from '../i18n/i18n-context'
import { formatKib } from '../utils/files-format'
import { MAX_COMMENT_BYTES, type ReviewTarget } from '../utils/review-draft'
import { lineText } from '../utils/review-message'
import { utf8Bytes } from '../utils/task-failure-message'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button, FOCUS_RING } from './ui/button'
import { Sheet } from './ui/sheet'

interface Props {
  // What the comment is on, or none (closed)
  target: ReviewTarget | null
  // The comment edited, else a new one
  initialText?: string
  onSave: (text: string) => void
  onClose: () => void
}

// Writing a review comment on lines of a diff or a file: where it is, the
// lines quoted (never a sensitive file's), and the comment.
export function ReviewCommentSheet({ target, onClose, ...rest }: Props) {
  const area = useRef<HTMLTextAreaElement>(null)
  const { t } = useT()
  return (
    <Sheet
      isOpen={!!target}
      onClose={onClose}
      focusOnOpen={() => area.current?.focus()}
      title={t(
        rest.initialText === undefined
          ? 'files.review.addTitle'
          : 'files.review.editTitle',
      )}
    >
      {target && (
        <CommentForm area={area} target={target} onClose={onClose} {...rest} />
      )}
    </Sheet>
  )
}

function CommentForm({
  area,
  target,
  initialText,
  onSave,
  onClose,
}: Omit<Props, 'target'> & {
  area: RefObject<HTMLTextAreaElement | null>
  target: ReviewTarget
}) {
  const { t, locale } = useT()
  const [text, setText] = useState(initialText ?? '')
  const size = utf8Bytes(text)
  const tooLong = size > MAX_COMMENT_BYTES
  const ok = text.trim() !== '' && !tooLong
  const save = () => {
    if (ok) onSave(text)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      save()
    }
  }
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="m-0 break-all font-term text-[12px]">
        <bdi>{visibleUnsafe(target.path)}</bdi>{' '}
        <span className="text-fg-muted">{lineText(target, t)}</span>
      </p>
      {target.sensitive ? (
        <p className="m-0 text-[12px] text-fg-muted">
          {t('files.review.notQuoted')}
        </p>
      ) : (
        target.quote !== undefined && (
          <pre
            data-testid="review-quote"
            className="m-0 max-h-40 overflow-auto rounded-control border border-border bg-bg p-2 font-term text-[12px] text-fg"
          >
            {visibleUnsafe(target.quote, true)}
          </pre>
        )
      )}
      <textarea
        aria-label={t('files.review.commentField')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        ref={area}
        rows={4}
        className={`min-h-24 w-full resize-y rounded-control border border-border bg-bg p-2 text-[13px] text-fg pointer-coarse:text-[16px] ${FOCUS_RING}`}
      />
      {tooLong && (
        <p className="m-0 text-[12px] text-danger">
          {t('files.review.tooLong', {
            size: formatKib(size, locale),
            max: formatKib(MAX_COMMENT_BYTES, locale, 0),
          })}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          onClick={save}
          disabled={!ok}
          // i18n-ignore: a key's name
          title="Ctrl+Enter"
        >
          {t(
            initialText === undefined
              ? 'files.review.add'
              : 'files.review.save',
          )}
        </Button>
      </div>
    </div>
  )
}
