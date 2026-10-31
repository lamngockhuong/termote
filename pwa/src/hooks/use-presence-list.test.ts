import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePresenceList } from './use-presence-list'

const key = (s: string) => s

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

// The elements the list draws, by key; animated ones have a transition
function render(items: string[], animated: string[] = []) {
  const els = new Map<string, HTMLElement>()
  const view = renderHook(
    ({ items }) => {
      const list = usePresenceList(items, key)
      for (const e of list.entries) {
        let el = els.get(e.key)
        if (!el) {
          el = document.createElement('div')
          if (animated.includes(e.key)) el.style.transitionDuration = '150ms'
          document.body.append(el)
          els.set(e.key, el)
        }
        list.ref(e.key)(el)
      }
      return list
    },
    { initialProps: { items } },
  )
  const shown = () =>
    view.result.current.entries.map((e) => (e.leaving ? `-${e.key}` : e.key))
  return { view, els, shown }
}

describe('usePresenceList', () => {
  it('lists the items, none leaving', () => {
    const { shown } = render(['a', 'b'])
    expect(shown()).toEqual(['a', 'b'])
  })

  it('takes a list made afresh at each render with the same items as unchanged', () => {
    let renders = 0
    const items = ['a', 'b']
    renderHook(() => {
      renders++
      return usePresenceList([...items], key)
    })
    expect(renders).toBe(1)
  })

  it('sees an item replaced in place as a change', () => {
    const { view, shown } = render(['a', 'b'])
    view.rerender({ items: ['a', 'c'] })
    expect(shown()).toEqual(['a', 'c'])
  })

  it('drops an item with nothing to animate at once', () => {
    const { view, shown } = render(['a', 'b'])
    view.rerender({ items: ['b'] })
    expect(shown()).toEqual(['b'])
  })

  it('keeps a removed item where it was until its transitionend', () => {
    const { view, els, shown } = render(['a', 'b', 'c'], ['b'])
    view.rerender({ items: ['a', 'c'] })
    expect(shown()).toEqual(['a', '-b', 'c'])
    // A child's transition bubbles up: not the item's own
    const child = document.createElement('span')
    els.get('b')!.append(child)
    act(() => {
      child.dispatchEvent(new Event('transitionend', { bubbles: true }))
    })
    expect(shown()).toEqual(['a', '-b', 'c'])
    act(() => {
      els.get('b')!.dispatchEvent(new Event('transitionend'))
    })
    expect(shown()).toEqual(['a', 'c'])
  })

  it('drops a removed item after its duration when no transitionend comes', () => {
    vi.useFakeTimers()
    const { view, shown } = render(['a', 'b'], ['a'])
    view.rerender({ items: ['b'] })
    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(shown()).toEqual(['-a', 'b'])
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(shown()).toEqual(['b'])
  })

  it('drops at once a removed item that is not told to leave', () => {
    const els = new Map<string, HTMLElement>()
    const view = renderHook(
      ({ items }) => {
        const list = usePresenceList(items, key, (k) => k !== 'a')
        for (const e of list.entries) {
          let el = els.get(e.key)
          if (!el) {
            el = document.createElement('div')
            el.style.transitionDuration = '150ms'
            els.set(e.key, el)
          }
          list.ref(e.key)(el)
        }
        return list
      },
      { initialProps: { items: ['a', 'b'] } },
    )
    view.rerender({ items: [] })
    expect(view.result.current.entries.map((e) => e.key)).toEqual(['b'])
  })

  it('places a leaving item at the end when the list got shorter than its place', () => {
    const { view, shown } = render(['a', 'b', 'c'], ['c'])
    view.rerender({ items: ['a'] })
    expect(shown()).toEqual(['a', '-c'])
  })

  it('keeps several leaving items in their order', () => {
    const { view, shown } = render(['a', 'b', 'c', 'd'], ['b', 'c'])
    view.rerender({ items: ['a', 'd'] })
    expect(shown()).toEqual(['a', '-b', '-c', 'd'])
  })

  it('shows an item added back while it leaves as staying', () => {
    const { view, shown } = render(['a', 'b'], ['b'])
    view.rerender({ items: ['a'] })
    view.rerender({ items: ['a', 'b'] })
    expect(shown()).toEqual(['a', 'b'])
  })

  it('keeps an item leaving across another change to the list', () => {
    const { view, shown } = render(['a', 'b'], ['a'])
    view.rerender({ items: ['b'] })
    view.rerender({ items: ['b', 'c'] })
    expect(shown()).toEqual(['-a', 'b', 'c'])
  })

  it('gives each key one ref callback, and forgets an element that left', () => {
    const { view, els } = render(['a'], ['a'])
    const ref = view.result.current.ref('a')
    expect(view.result.current.ref('a')).toBe(ref)
    ref(null)
    // No element: nothing to wait for
    view.rerender({ items: [] })
    expect(view.result.current.entries).toEqual([])
    expect(els.size).toBe(1)
  })

  it('times out an item whose element is gone by the time it leaves', () => {
    vi.useFakeTimers()
    const { view, els, shown } = render(['a'], ['a'])
    view.rerender({ items: [] })
    expect(shown()).toEqual(['-a'])
    // Unmounted early: the ref forgets it, the timer still ends it
    view.result.current.ref('a')(null)
    els.get('a')!.dispatchEvent(new Event('transitionend'))
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(shown()).toEqual([])
  })

  it('leaves no timer behind once unmounted', () => {
    vi.useFakeTimers()
    const { view } = render(['a'], ['a'])
    view.rerender({ items: [] })
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
