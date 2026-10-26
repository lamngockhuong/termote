import { type KeyboardEvent, type RefObject, useRef, useState } from 'react'
import { MAX_COMMENT_BYTES, type ReviewTarget } from '../utils/review-draft'
import { lineLabel } from '../utils/review-message'
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
  return (
    <Sheet
      isOpen={!!target}
      onClose={onClose}
      focusOnOpen={() => area.current?.focus()}
      title={rest.initialText === undefined ? 'Add a comment' : 'Edit comment'}
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
        <span className="text-fg-muted">{lineLabel(target)}</span>
      </p>
      {target.sensitive ? (
        <p className="m-0 text-[12px] text-fg-muted">
          Lines not quoted: may contain secrets
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
        aria-label="Comment"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        ref={area}
        rows={4}
        className={`min-h-24 w-full resize-y rounded-control border border-border bg-bg p-2 text-[13px] text-fg pointer-coarse:text-[16px] ${FOCUS_RING}`}
      />
      {tooLong && (
        <p className="m-0 text-[12px] text-danger">
          Too long: {(size / 1024).toFixed(1)} of {MAX_COMMENT_BYTES / 1024} KiB
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          onClick={save}
          disabled={!ok}
          title="Ctrl+Enter"
        >
          {initialText === undefined ? 'Add' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
