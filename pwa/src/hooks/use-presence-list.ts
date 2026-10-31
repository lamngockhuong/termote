import { useCallback, useEffect, useRef, useState } from 'react'
import { transitionMs } from './use-exit-transition'

// Past the longest transition, an item that never sent transitionend goes
const SLACK_MS = 50

// The look of an item leaving a list (usePresenceList), faster than it
// came in; its own transition has to take opacity and scale
export const LEAVE_TO =
  'pointer-events-none scale-95 opacity-0 duration-(--duration-fast)'

export interface Presence<T> {
  item: T
  key: string
  // Removed from the list: shown in its closed look (inert) until its exit
  // transition ends
  leaving: boolean
}

interface Gone<T> {
  item: T
  // Where it was in the list it left
  index: number
}

// A list that keeps an item removed from it for its exit transition, where
// it was, then drops it. ref(key) goes on each item's element: the length
// of that element's transition decides how long. An item with none (reduced
// motion, jsdom) goes in the same render; one added back stays. leaves
// tells which removed keys fade out: an item only filtered out of sight goes
// at once.
export function usePresenceList<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  leaves: (key: string) => boolean = () => true,
) {
  const els = useRef(new Map<string, Element>())
  const refs = useRef(new Map<string, (el: Element | null) => void>())
  const [prev, setPrev] = useState(items)
  const [gone, setGone] = useState<ReadonlyMap<string, Gone<T>>>(new Map())

  // Adjusted while rendering, so a removed item never misses a frame. Item
  // by item: a list filtered afresh at each render is the same list.
  const changed =
    prev.length !== items.length || prev.some((item, i) => item !== items[i])
  if (changed) {
    setPrev(items)
    const keys = new Set(items.map(getKey))
    const next = new Map([...gone].filter(([key]) => !keys.has(key)))
    prev.forEach((item, index) => {
      const key = getKey(item)
      if (
        !keys.has(key) &&
        leaves(key) &&
        transitionMs(els.current.get(key)) > 1
      )
        next.set(key, { item, index })
    })
    setGone(next)
  }

  const drop = useCallback((key: string) => {
    setGone((m) => {
      const next = new Map(m)
      next.delete(key)
      return next
    })
  }, [])

  useEffect(() => {
    const cleanups = [...gone.keys()].map((key) => {
      const el = els.current.get(key)
      const onEnd = (e: Event) => {
        if (e.target === el) drop(key)
      }
      el?.addEventListener('transitionend', onEnd)
      const timer = setTimeout(() => drop(key), transitionMs(el) + SLACK_MS)
      return () => {
        el?.removeEventListener('transitionend', onEnd)
        clearTimeout(timer)
      }
    })
    return () => {
      for (const fn of cleanups) fn()
    }
  }, [gone, drop])

  const entries: Presence<T>[] = items.map((item) => ({
    item,
    key: getKey(item),
    leaving: false,
  }))
  for (const [key, { item, index }] of [...gone].sort(
    (a, b) => a[1].index - b[1].index,
  ))
    entries.splice(Math.min(index, entries.length), 0, {
      item,
      key,
      leaving: true,
    })

  const ref = useCallback((key: string) => {
    let fn = refs.current.get(key)
    if (!fn) {
      fn = (el: Element | null) => {
        if (el) els.current.set(key, el)
        else els.current.delete(key)
      }
      refs.current.set(key, fn)
    }
    return fn
  }, [])

  return { entries, ref }
}
