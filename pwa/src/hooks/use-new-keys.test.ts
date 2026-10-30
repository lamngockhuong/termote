import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useNewKeys } from './use-new-keys'

function render(keys: string[], reset?: unknown) {
  return renderHook(({ keys, reset }) => useNewKeys(keys, reset), {
    initialProps: { keys, reset },
  })
}

describe('useNewKeys', () => {
  it('counts nothing the list showed at first as new', () => {
    const view = render(['a', 'b'])
    expect(view.result.current('a')).toBe(false)
    expect(view.result.current('b')).toBe(false)
  })

  it('tells an item added later as new', () => {
    const view = render(['a'])
    view.rerender({ keys: ['a', 'b'], reset: undefined })
    expect(view.result.current('a')).toBe(false)
    expect(view.result.current('b')).toBe(true)
  })

  it('waits for the first items: a list that loads shows them as they were', () => {
    const view = render([])
    expect(view.result.current('a')).toBe(false)
    view.rerender({ keys: ['a', 'b'], reset: undefined })
    expect(view.result.current('a')).toBe(false)
    view.rerender({ keys: ['a', 'b', 'c'], reset: undefined })
    expect(view.result.current('c')).toBe(true)
  })

  it('starts again when the reset key changes', () => {
    const view = render(['a'], 1)
    view.rerender({ keys: ['x', 'y'], reset: 2 })
    expect(view.result.current('x')).toBe(false)
    expect(view.result.current('a')).toBe(true)
  })
})
