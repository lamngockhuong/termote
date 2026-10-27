import { type ReactNode, useEffect, useRef } from 'react'
import type { MarkdownEditLayout as Layout } from '../hooks/use-settings'

// A Markdown file being edited: its editor, its preview beside it, or the
// preview alone. The editor stays mounted while hidden, so its undo history,
// selection and search panel are there again when it shows.
export function MarkdownEditLayout({
  mode,
  editor,
  preview,
}: {
  mode: Layout
  editor: ReactNode
  // Rendered only while it shows
  preview: ReactNode
}) {
  const editorBox = useRef<HTMLDivElement>(null)
  const previewBox = useRef<HTMLDivElement>(null)
  const was = useRef(mode)

  // The editor went out of sight with the focus (or the focus fell to the
  // page): the preview takes it, so its keys (Ctrl+S, scrolling) still work
  useEffect(() => {
    const before = was.current
    was.current = mode
    if (mode !== 'preview' || before === 'preview') return
    const active = document.activeElement
    if (
      active &&
      active !== document.body &&
      !editorBox.current?.contains(active)
    )
      return
    previewBox.current
      ?.querySelector<HTMLElement>('[data-testid="markdown-preview"]')
      ?.focus({ preventScroll: true })
  }, [mode])

  return (
    <div className="flex min-h-0 flex-1" data-layout={mode}>
      <div
        ref={editorBox}
        className={`min-h-0 min-w-0 flex-1 flex-col ${mode === 'preview' ? 'hidden' : 'flex'}`}
      >
        {editor}
      </div>
      {mode !== 'source' && (
        <div
          ref={previewBox}
          className={`flex min-h-0 min-w-0 flex-1 flex-col ${mode === 'split' ? 'border-l border-border' : ''}`}
        >
          {preview}
        </div>
      )}
    </div>
  )
}
