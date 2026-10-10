import { useEffect, useState } from 'react'

export interface ScrollEdges {
  // Content hidden before the visible part (scrolled away from the start)
  start: boolean
  // Content hidden after the visible part
  end: boolean
}

// Width of each fade, in px: less than half a 44px key
const FADE_PX = 24

// The mask that fades the ends of a horizontal scroller where content is
// hidden, or undefined when nothing is. A mask only changes what is painted,
// never the size, so the toolbar (and the terminal above it) keeps its height.
export function scrollEdgeMask({ start, end }: ScrollEdges) {
  if (!start && !end) return undefined
  const from = start ? `transparent, #000 ${FADE_PX}px` : '#000, #000'
  const to = end ? `#000 calc(100% - ${FADE_PX}px), transparent` : '#000, #000'
  return `linear-gradient(to right, ${from}, ${to})`
}

function readEdges(el: HTMLElement): ScrollEdges {
  // 1px of slack: scroll positions are fractional on high-DPI screens
  return {
    start: el.scrollLeft > 1,
    end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
  }
}

// Which ends of a horizontal scroller still hide content. Read again on
// scroll, when the scroller or its content resizes, and when contentKey
// changes (keys added or removed: new children to observe). Takes the element
// itself (from a callback ref kept in state), not a ref object: a scroller
// unmounted and mounted again (IME mode) is a new element to listen to.
export function useScrollEdges(
  el: HTMLElement | null,
  contentKey?: unknown,
): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ start: false, end: false })

  // biome-ignore lint/correctness/useExhaustiveDependencies: contentKey only marks a change of the children
  useEffect(() => {
    if (!el) return
    const update = () => {
      const next = readEdges(el)
      setEdges((prev) =>
        prev.start === next.start && prev.end === next.end ? prev : next,
      )
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(update)
      observer.observe(el)
      for (const child of el.children) observer.observe(child)
    }
    return () => {
      el.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [el, contentKey])

  return edges
}
