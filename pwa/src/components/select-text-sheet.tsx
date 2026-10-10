import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { usePaneText } from '../hooks/use-pane-text'
import { copyText } from '../utils/copy-text'
import { splitUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { Sheet } from './ui/sheet'

// The text a range of the sheet's <pre> stands for: each ⟨U+XXXX⟩ mark is
// the character it shows (data-raw), not the mark's own letters.
export function rangeText(range: Range): string {
  const frag = range.cloneContents()
  for (const el of frag.querySelectorAll<HTMLElement>('[data-raw]')) {
    el.replaceWith(el.dataset.raw as string)
  }
  // A fragment's textContent is never null
  return frag.textContent as string
}

// The pane's text as plain characters, for the device's own selection:
// a long press and its handles on a phone, a drag with a mouse. Mounted
// only while open; App keys it by pane.
export function SelectTextSheet({
  onClose,
  paneId,
  useServer,
  readBuffer,
  onCopied,
}: {
  onClose: () => void
  paneId: string | undefined
  // Read the history from the server (caps.paneText, not view-only)
  useServer: boolean
  // The terminal's buffer, when the server's text is not there
  readBuffer: () => string
  onCopied: (result: 'ok' | 'failed') => void
}) {
  const { text, source, loading, truncated, canLoadMore, loadMore } =
    usePaneText({ paneId, useServer, readBuffer })
  const preRef = useRef<HTMLPreElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState(false)
  const parts = useMemo(() => splitUnsafe(text), [text])

  // Shown from the bottom, where the prompt and the latest output are
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && text) el.scrollTop = el.scrollHeight
  }, [text])

  const selectionRange = useCallback((): Range | null => {
    const sel = document.getSelection()
    const pre = preRef.current
    if (!sel || sel.isCollapsed || !sel.rangeCount || !pre) return null
    const range = sel.getRangeAt(0)
    return pre.contains(range.commonAncestorContainer) ? range : null
  }, [])

  useEffect(() => {
    const onChange = () => setSelected(!!selectionRange())
    document.addEventListener('selectionchange', onChange)
    return () => document.removeEventListener('selectionchange', onChange)
  }, [selectionRange])

  const copy = (value: string) => {
    void copyText(value).then(onCopied)
  }

  return (
    <Sheet isOpen onClose={onClose} title="Select text">
      <div className="flex flex-col">
        {source === 'buffer' && !loading && (
          <p className="m-0 px-4 pt-3 text-[13px] text-fg-muted">
            Only what the terminal on this page holds: the history stays on the
            server.
          </p>
        )}
        {truncated && (
          <p className="m-0 px-4 pt-3 text-[13px] text-fg-muted">
            The oldest lines were left out.
          </p>
        )}
        <div
          ref={scrollRef}
          className="mx-4 my-3 h-[55vh] overflow-auto rounded-control border border-border bg-bg"
        >
          {loading ? (
            <p className="m-0 p-3 text-[13px] text-fg-muted">Loading…</p>
          ) : (
            <pre
              ref={preRef}
              data-testid="select-text"
              // The device's own Copy (its menu, Ctrl+C) copies the
              // characters a mark stands for, as the Copy button does
              onCopy={(e) => {
                const range = selectionRange()
                if (!range) return
                e.preventDefault()
                e.clipboardData.setData('text/plain', rangeText(range))
              }}
              className="m-0 w-max min-w-full select-text p-3 font-term text-[13px] leading-snug whitespace-pre text-fg [-webkit-touch-callout:default] [-webkit-user-select:text]"
            >
              {parts.map((p, i) =>
                p.mark ? (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder
                    key={i}
                    data-raw={p.text}
                    className="text-warning"
                  >
                    {p.mark}
                  </span>
                ) : (
                  p.text
                ),
              )}
            </pre>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
          {canLoadMore && (
            <Button variant="ghost" onClick={loadMore}>
              Load more
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button disabled={loading || !text} onClick={() => copy(text)}>
              Copy all
            </Button>
            <Button
              variant="primary"
              disabled={!selected}
              // A tap must not take the selection away before the click
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const range = selectionRange()
                if (range) copy(rangeText(range))
              }}
            >
              Copy
            </Button>
          </div>
        </div>
      </div>
    </Sheet>
  )
}
