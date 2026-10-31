import { type RefObject, useEffect, useState } from 'react'

// Past the longest transition, an element that never sent transitionend (a
// hidden tab, a browser that cannot animate display) is removed anyway
const SLACK_MS = 50

// The longest transition of the element, delay included, in ms. 0 where
// nothing animates: jsdom has no stylesheet, and reduced motion cuts every
// transition to 0.01ms (index.css).
export function transitionMs(el: Element | null | undefined): number {
  if (!el) return 0
  const style = getComputedStyle(el)
  const times = (list: string) =>
    list
      .split(',')
      .map((v) => (v.trim().endsWith('ms') ? 1 : 1000) * (parseFloat(v) || 0))
  const durations = times(style.transitionDuration)
  const delays = times(style.transitionDelay)
  return Math.max(0, ...durations.map((d, i) => d + (delays[i] ?? 0)))
}

// Keeps an element in the tree for its exit transition once open turns
// false: closing is true meanwhile, so it can take its closed look (and
// inert). It goes once its own transition ends, or its duration and a little
// more has passed. An element with no transition (reduced motion) goes in the
// same render, never showing a closing frame. Opening again while it closes
// keeps it mounted; opens counts each opening, for a key when what is inside
// must start afresh (its focus on open, a search typed before).
export function useExitTransition(
  open: boolean,
  ref: RefObject<Element | null>,
) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)
  const [opens, setOpens] = useState(open ? 1 : 0)

  // Adjusted while rendering, so a close with nothing to animate unmounts
  // in the same commit
  if (open && (!mounted || closing)) {
    setMounted(true)
    setClosing(false)
    setOpens(opens + 1)
  } else if (!open && mounted && !closing) {
    if (transitionMs(ref.current) > 1) setClosing(true)
    else setMounted(false)
  }

  useEffect(() => {
    if (!closing) return
    const el = ref.current
    const done = () => {
      setMounted(false)
      setClosing(false)
    }
    // Only its own transitions: a child's (a button's hover) also bubbles
    const onEnd = (e: Event) => {
      if (e.target === el) done()
    }
    el?.addEventListener('transitionend', onEnd)
    const timer = setTimeout(done, transitionMs(el) + SLACK_MS)
    return () => {
      el?.removeEventListener('transitionend', onEnd)
      clearTimeout(timer)
    }
  }, [closing, ref])

  return { mounted, closing, opens }
}
