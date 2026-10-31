import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { flushSync } from 'react-dom'

// Lines per block: rendered, measured and dropped together
export const BLOCK_LINES = 200
// A row's height until a block is measured: text-[12px] leading-[1.6]
const ROW_HEIGHT = 19.2
// A character of the terminal font, for the rows a wrapped line takes
// until its block is measured
const CHAR_WIDTH = 7.2

export interface LineWindow {
  // Blocks first to last (0-based) are in the page; before and after are
  // the heights of the lines above and below them
  first: number
  last: number
  before: number
  after: number
  // The ref of block b's element, measured once it is in the page
  measure: (b: number) => (el: HTMLDivElement | null) => void
  // Puts the block of line (1-based) in the page at the next render
  reveal: (line: number) => void
  // The frame was scrolled from outside (a jump, a restored offset): the
  // window follows, and the lines now shown are the ones kept in place
  sync: () => void
}

// Which blocks of lines a scrolling frame shows (with a view's height more
// above and below), so a file of any length costs the page a few hundred
// rows. A block is estimated until it is measured; whatever a measure or a
// new window changes above the view, the line at its top stays where it
// was on screen. null when not enabled.
export function useLineWindow(
  frame: RefObject<HTMLDivElement | null>,
  lines: string[],
  wrap: boolean,
  enabled: boolean,
): LineWindow | null {
  const blocks = Math.ceil(lines.length / BLOCK_LINES)
  const [width, setWidth] = useState(0)
  const [range, setRange] = useState<[number, number]>([0, 0])
  // Bumped when a measured height changes the layout
  const [, setVersion] = useState(0)
  const rowHeight = useRef(ROW_HEIGHT)
  // Unwrapped, a block's height does not depend on the frame's width
  const layoutWidth = wrap ? width : 0

  // Rows each block takes before it is measured: one a line, or a wrapped
  // line's estimate in the frame's width
  const estimates = useMemo(() => {
    const rows = new Float64Array(blocks)
    const gutter = (String(lines.length).length + 1) * CHAR_WIDTH + 16
    const perRow = Math.max(1, Math.floor((layoutWidth - gutter) / CHAR_WIDTH))
    for (let b = 0; b < blocks; b++) {
      const end = Math.min(lines.length, (b + 1) * BLOCK_LINES)
      if (!wrap || layoutWidth === 0) {
        rows[b] = end - b * BLOCK_LINES
        continue
      }
      let n = 0
      for (let i = b * BLOCK_LINES; i < end; i++) {
        n += Math.max(1, Math.ceil(lines[i].length / perRow))
      }
      rows[b] = n
    }
    return rows
  }, [lines, blocks, wrap, layoutWidth])
  // Heights measured (NaN until then), for these lines in this layout
  // biome-ignore lint/correctness/useExhaustiveDependencies: other lines, a wrap or a width re-lay every block
  const heights = useMemo(
    () => new Float64Array(blocks).fill(Number.NaN),
    [blocks, lines, wrap, layoutWidth],
  )

  // Where each block starts, and the end of the last at blocks
  const offsets = useCallback(() => {
    const at = new Float64Array(blocks + 1)
    for (let b = 0; b < blocks; b++) {
      const h = heights[b]
      at[b + 1] =
        at[b] + (Number.isNaN(h) ? estimates[b] * rowHeight.current : h)
    }
    return at
  }, [blocks, heights, estimates])

  const update = useCallback(() => {
    const el = frame.current
    if (!el || blocks === 0) return
    const at = offsets()
    const view = el.clientHeight
    const from = el.scrollTop - view
    const to = el.scrollTop + 2 * view
    let first = 0
    while (first < blocks - 1 && at[first + 1] <= from) first++
    let last = first
    while (last < blocks - 1 && at[last + 1] < to) last++
    setRange((r) => (r[0] === first && r[1] === last ? r : [first, last]))
  }, [frame, blocks, offsets])

  // The line at the top of the view, where it starts in the content and
  // where it was on screen. A render that moves it in the content (an
  // estimate turned into a measure, a block put in the page above, a new
  // wrap) puts it back where it was on screen, so the user reads on; a
  // scroll alone never moves it in the content, so is never undone.
  const anchor = useRef<{ line: string; y: number; screen: number } | null>(
    null,
  )
  const capture = useCallback(() => {
    const el = frame.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const rows = el.querySelectorAll<HTMLElement>('[data-line]')
    let lo = 0
    let hi = rows.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (rows[mid].getBoundingClientRect().bottom > top) {
        found = mid
        hi = mid - 1
      } else lo = mid + 1
    }
    const row = rows[found]
    const screen = row ? row.getBoundingClientRect().top - top : 0
    anchor.current = row
      ? { line: row.dataset.line as string, y: screen + el.scrollTop, screen }
      : null
  }, [frame])
  useLayoutEffect(() => {
    const el = frame.current
    const a = anchor.current
    if (!enabled || !el) return
    const row = a && el.querySelector<HTMLElement>(`[data-line="${a.line}"]`)
    if (a && row) {
      const y =
        row.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop
      if (Math.abs(y - a.y) >= 0.5) el.scrollTop = y - a.screen
    }
    capture()
  })

  // Scrolling and resizing move the window; a scroll is handled once a frame
  useEffect(() => {
    const el = frame.current
    if (!enabled || !el) return
    // The anchor follows every scroll at once; the window, rendered at
    // once too, follows a frame later, so a render never finds an anchor
    // older than the scroll
    let queued = 0
    const onScroll = () => {
      capture()
      if (queued) return
      queued = requestAnimationFrame(() => {
        queued = 0
        flushSync(update)
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        flushSync(() => setWidth(el.clientWidth))
        flushSync(update)
      })
      ro.observe(el)
    }
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(queued)
      ro?.disconnect()
    }
  }, [frame, enabled, update, capture])

  // The window for where the frame is now: the first render, other lines,
  // a new layout
  useLayoutEffect(() => {
    if (enabled) update()
  }, [enabled, update])

  // Blocks in the page are measured as they lay out; the new heights are
  // rendered before the next paint, the anchor keeping the view in place
  const observer = useRef<ResizeObserver | null>(null)
  const observed = useRef(new Map<number, HTMLDivElement>())
  const onSized = useRef<(entries: ResizeObserverEntry[]) => void>(() => {})
  useLayoutEffect(() => {
    onSized.current = (entries) => {
      let changed = false
      for (const e of entries) {
        const target = e.target as HTMLDivElement
        const b = Number(target.dataset.block)
        if (!(b < blocks)) continue
        const h = target.getBoundingClientRect().height
        if (h === 0 || Math.abs(h - heights[b]) < 0.5) continue
        heights[b] = h
        if (!wrap && estimates[b] === BLOCK_LINES) {
          rowHeight.current = h / BLOCK_LINES
        }
        changed = true
      }
      if (!changed) return
      flushSync(() => setVersion((v) => v + 1))
      // Not flushed: a block put in the page here would be observed in this
      // same delivery, which the browser reports as a loop
      update()
    }
  })
  useEffect(() => {
    if (!enabled || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => onSized.current(entries))
    observer.current = ro
    for (const el of observed.current.values()) ro.observe(el)
    return () => {
      ro.disconnect()
      observer.current = null
    }
  }, [enabled])
  // One ref callback a block, kept so a render never detaches it
  const refs = useRef(new Map<number, (el: HTMLDivElement | null) => void>())
  const measure = useCallback((b: number) => {
    let ref = refs.current.get(b)
    if (!ref) {
      ref = (el: HTMLDivElement | null) => {
        const old = observed.current.get(b)
        if (old) observer.current?.unobserve(old)
        observed.current.delete(b)
        if (el) {
          observed.current.set(b, el)
          observer.current?.observe(el)
        }
      }
      refs.current.set(b, ref)
    }
    return ref
  }, [])

  const reveal = useCallback(
    (line: number) => {
      const b = Math.min(blocks - 1, Math.floor((line - 1) / BLOCK_LINES))
      if (b < 0) return
      setRange((r) =>
        r[0] <= b && b <= r[1]
          ? r
          : [Math.max(0, b - 1), Math.min(blocks - 1, b + 1)],
      )
    },
    [blocks],
  )
  const sync = useCallback(() => {
    capture()
    update()
  }, [capture, update])

  if (!enabled || blocks === 0) return null
  const first = Math.min(range[0], blocks - 1)
  const last = Math.min(Math.max(range[1], first), blocks - 1)
  const at = offsets()
  return {
    first,
    last,
    before: at[first],
    after: at[blocks] - at[last + 1],
    measure,
    reveal,
    sync,
  }
}
