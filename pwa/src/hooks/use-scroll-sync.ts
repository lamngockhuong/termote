import { useEffect, useRef } from 'react'

// A block of a Markdown file in its preview: the line of the file it starts
// on, and how far down the scroll box's content it is laid out (px)
export interface Anchor {
  line: number
  top: number
}

// One of the two views of a Markdown draft (its editor, its preview) that
// scroll together. Lines are fractional: 12.5 is halfway down line 12.
export interface SyncSide {
  el: HTMLElement
  // The line at the top of the visible part
  topLine: () => number
  // Scrolls so that line is at the top
  scrollToLine: (line: number) => void
}

// Anchors by line, each one further down than the one before: of two on
// one line the first is kept, and one laid out above an anchor of an earlier
// line (a block that moved, or measured while hidden) is dropped
export function orderAnchors(anchors: Anchor[]): Anchor[] {
  const sorted = [...anchors].sort((a, b) => a.line - b.line || a.top - b.top)
  const out: Anchor[] = []
  for (const a of sorted) {
    const last = out[out.length - 1]
    if (last && (a.line === last.line || a.top < last.top)) continue
    out.push(a)
  }
  return out
}

// Where line is laid out, between the anchors around it in proportion;
// before the first anchor or after the last, at that anchor. anchors come
// from orderAnchors.
export function lineToOffset(anchors: Anchor[], line: number): number {
  if (!anchors.length) return 0
  let i = 0
  while (i + 1 < anchors.length && anchors[i + 1].line <= line) i++
  const a = anchors[i]
  const b = anchors[i + 1]
  if (!b || line <= a.line) return a.top
  return a.top + ((b.top - a.top) * (line - a.line)) / (b.line - a.line)
}

// The line laid out at top: the inverse of lineToOffset
export function offsetToLine(anchors: Anchor[], top: number): number {
  if (!anchors.length) return 1
  let i = 0
  while (i + 1 < anchors.length && anchors[i + 1].top <= top) i++
  const a = anchors[i]
  const b = anchors[i + 1]
  // Past the last one's top, b is further down than a (orderAnchors)
  if (!b || top <= a.top) return a.line
  return a.line + ((b.line - a.line) * (top - a.top)) / (b.top - a.top)
}

// A scroll event this close (px) to where the other side's scroll put this
// one is that scroll's own: CodeMirror, wrapping lines, may move it again a
// little as it measures them
const OWN = 2

// The editor and the preview of a Markdown draft scroll together: the line
// at the top of the one scrolled goes to the top of the other, once a frame.
// The side the user works in (the one scrolled last, the editor while typed
// in) is where they read: when the preview is laid out again (text typed, a
// diagram drawn, a disclosure opened) the other side follows it, and when
// sync starts it leads from lead (the preview, when it showed alone before).
// Off while either side is missing.
export function useScrollSync(
  editor: SyncSide | null,
  preview: SyncSide | null,
  lead: 'editor' | 'preview' = 'editor',
) {
  const leadRef = useRef(lead)
  leadRef.current = lead
  useEffect(() => {
    if (!editor || !preview) return
    // Where this code last scrolled each side
    const target = new Map<SyncSide, number>()
    let frame = 0
    let leader = leadRef.current === 'preview' ? preview : editor
    const other = (side: SyncSide) => (side === editor ? preview : editor)
    const follow = (from: SyncSide) => {
      const to = other(from)
      to.scrollToLine(from.topLine())
      target.set(to, to.el.scrollTop)
    }
    const onScroll = (from: SyncSide) => () => {
      const t = target.get(from)
      if (t !== undefined && Math.abs(from.el.scrollTop - t) < OWN) return
      target.delete(from)
      leader = from
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => follow(from))
    }
    const fromEditor = onScroll(editor)
    const fromPreview = onScroll(preview)
    const typed = () => {
      leader = editor
    }
    editor.el.addEventListener('scroll', fromEditor, { passive: true })
    editor.el.addEventListener('keydown', typed)
    preview.el.addEventListener('scroll', fromPreview, { passive: true })
    const ro =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => follow(leader))
    ro?.observe(preview.el.firstElementChild ?? preview.el)
    follow(leader)
    return () => {
      cancelAnimationFrame(frame)
      ro?.disconnect()
      editor.el.removeEventListener('scroll', fromEditor)
      editor.el.removeEventListener('keydown', typed)
      preview.el.removeEventListener('scroll', fromPreview)
    }
  }, [editor, preview])
}
