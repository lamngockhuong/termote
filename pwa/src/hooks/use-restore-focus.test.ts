import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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
})
