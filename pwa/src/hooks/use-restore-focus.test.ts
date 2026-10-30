import { renderHook } from '@testing-library/react'
import type { RefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRestoreFocus } from './use-restore-focus'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('useRestoreFocus', () => {
  it('gives focus back to the element that had it on mount', () => {
    document.body.innerHTML =
      '<button id="a">a</button><button id="b">b</button>'
    const a = document.getElementById('a') as HTMLElement
    a.focus()
    const view = renderHook(() => useRestoreFocus())
    ;(document.getElementById('b') as HTMLElement).focus()
    view.unmount()
    expect(document.activeElement).toBe(a)
  })

  it('gives the focus ring back only if the element had one', () => {
    document.body.innerHTML = '<button id="a">a</button>'
    const a = document.getElementById('a') as HTMLElement
    a.focus()
    const focus = vi.spyOn(a, 'focus')
    for (const ring of [false, true]) {
      // Safari rings an element focused right after a tap
      vi.spyOn(a, 'matches').mockReturnValueOnce(ring)
      renderHook(() => useRestoreFocus()).unmount()
      expect(focus).toHaveBeenLastCalledWith({ focusVisible: ring })
    }
  })

  it('leaves focus alone when told to skip at unmount', () => {
    document.body.innerHTML =
      '<button id="a">a</button><button id="b">b</button>'
    const a = document.getElementById('a') as HTMLElement
    a.focus()
    const skip = { current: false }
    const view = renderHook(() => useRestoreFocus(undefined, skip))
    const b = document.getElementById('b') as HTMLElement
    b.focus()
    skip.current = true
    view.unmount()
    expect(document.activeElement).toBe(b)
  })

  it('leaves focus alone when that element is gone', () => {
    document.body.innerHTML =
      '<button id="a">a</button><button id="b">b</button>'
    const a = document.getElementById('a') as HTMLElement
    a.focus()
    const view = renderHook(() => useRestoreFocus())
    const b = document.getElementById('b') as HTMLElement
    b.focus()
    a.remove()
    view.unmount()
    expect(document.activeElement).toBe(b)
  })

  it('gives focus to the fallback when that element is gone', () => {
    document.body.innerHTML = '<button id="a">a</button><div id="f"></div>'
    const a = document.getElementById('a') as HTMLElement
    const f = document.getElementById('f') as HTMLElement
    f.tabIndex = -1
    a.focus()
    const fallback: RefObject<HTMLElement | null> = { current: f }
    const view = renderHook(() => useRestoreFocus(fallback))
    a.remove()
    view.unmount()
    expect(document.activeElement).toBe(f)
  })

  it('gives focus to the fallback when that element takes none', () => {
    document.body.innerHTML =
      '<div id="a" tabindex="0">a</div><div id="f" tabindex="-1"></div>'
    const a = document.getElementById('a') as HTMLElement
    const f = document.getElementById('f') as HTMLElement
    a.focus()
    const view = renderHook(() => useRestoreFocus({ current: f }))
    // No longer focusable, as a disabled button
    a.blur()
    a.removeAttribute('tabindex')
    view.unmount()
    expect(document.activeElement).toBe(f)
  })

  it('never takes focus from where it went for the fallback', () => {
    document.body.innerHTML =
      '<button id="a">a</button><button id="b">b</button><div id="f"></div>'
    const a = document.getElementById('a') as HTMLElement
    const b = document.getElementById('b') as HTMLElement
    const f = document.getElementById('f') as HTMLElement
    f.tabIndex = -1
    a.focus()
    const view = renderHook(() => useRestoreFocus({ current: f }))
    b.focus()
    a.remove()
    view.unmount()
    expect(document.activeElement).toBe(b)
  })

  it('gives focus back when told, and not again at unmount', () => {
    document.body.innerHTML =
      '<button id="a">a</button><button id="b">b</button>'
    const a = document.getElementById('a') as HTMLElement
    const b = document.getElementById('b') as HTMLElement
    a.focus()
    const view = renderHook(() => useRestoreFocus())
    b.focus()
    view.result.current()
    expect(document.activeElement).toBe(a)
    b.focus()
    view.result.current()
    view.unmount()
    expect(document.activeElement).toBe(b)
  })

  it('does nothing when told before its effect ran', () => {
    document.body.innerHTML = '<button id="a">a</button>'
    const a = document.getElementById('a') as HTMLElement
    a.focus()
    let rendered = false
    // The function exists from the first render; the opener is read later
    renderHook(() => {
      const restore = useRestoreFocus()
      if (!rendered) restore()
      rendered = true
    })
    expect(document.activeElement).toBe(a)
  })
})
