import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dropStaleViewerEntry,
  onViewerEntryGone,
  useHistoryClose,
  viewerClosing,
  viewerOnTop,
} from './use-history-close'

const KEY = 'termoteViewer'
const state = () => window.history.state as Record<string, unknown> | null

// jsdom answers back() with popstate a task later
const popped = () =>
  new Promise<void>((resolve) =>
    window.addEventListener('popstate', () => resolve(), { once: true }),
  )

beforeEach(() => {
  window.history.replaceState({ app: 1 }, '', '/#/s/main/0')
})
afterEach(async () => {
  vi.useRealTimers()
  // history.back() real again before the hook below calls it
  vi.restoreAllMocks()
  // A hook still mounted takes its entry off as it unmounts: wait for that
  // popstate, or it would land in the next test
  const pop = popped()
  cleanup()
  if (viewerClosing()) await pop
})

describe('useHistoryClose', () => {
  it('pushes an entry of its own at the same URL, keeping the state', () => {
    const before = window.history.length
    renderHook(() => useHistoryClose(vi.fn()))
    expect(window.history.length).toBe(before + 1)
    expect(window.location.hash).toBe('#/s/main/0')
    expect(state()).toMatchObject({ app: 1, [KEY]: expect.any(String) })
    expect(viewerOnTop()).toBe(true)
  })

  it('Back closes it', async () => {
    const onClose = vi.fn()
    renderHook(() => useHistoryClose(onClose))
    const pop = popped()
    window.history.back()
    await pop
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(viewerOnTop()).toBe(false)
  })

  it('closing from inside goes back once, and onClose follows popstate', async () => {
    const onClose = vi.fn()
    const back = vi.spyOn(window.history, 'back')
    const { result } = renderHook(() => useHistoryClose(onClose))
    const pop = popped()
    act(() => result.current())
    expect(back).toHaveBeenCalledTimes(1)
    expect(viewerClosing()).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    // A second press meanwhile does not go back again
    act(() => result.current())
    expect(back).toHaveBeenCalledTimes(1)
    await pop
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(viewerClosing()).toBe(false)
    expect(state()).toEqual({ app: 1 })
  })

  it('closes without going back when its entry is gone already', () => {
    const onClose = vi.fn()
    const back = vi.spyOn(window.history, 'back')
    const { result } = renderHook(() => useHistoryClose(onClose))
    // Another navigation pushed an entry over it
    window.history.pushState({ other: 1 }, '', '/#/s/main/1')
    act(() => result.current())
    expect(back).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => result.current())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('works without crypto.randomUUID (plain HTTP on a LAN address)', () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new TypeError('crypto.randomUUID is not a function')
    })
    renderHook(() => useHistoryClose(vi.fn()))
    expect(viewerOnTop()).toBe(true)
  })

  it('lets viewers open again when the popstate of its back() never comes', () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(window.history, 'back').mockImplementation(() => {})
      const { result } = renderHook(() => useHistoryClose(vi.fn()))
      act(() => result.current())
      expect(viewerClosing()).toBe(true)
      vi.advanceTimersByTime(999)
      expect(viewerClosing()).toBe(true)
      vi.advanceTimersByTime(1)
      expect(viewerClosing()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the mark of the viewer open now', () => {
    renderHook(() => useHistoryClose(vi.fn()))
    dropStaleViewerEntry()
    expect(viewerOnTop()).toBe(true)
  })

  it('an earlier viewer unmounting leaves the open one its mark', () => {
    const first = renderHook(() => useHistoryClose(vi.fn()))
    renderHook(() => useHistoryClose(vi.fn()))
    // The first's entry is under the second's: unmounting pops nothing
    first.unmount()
    dropStaleViewerEntry()
    expect(viewerOnTop()).toBe(true)
  })

  it('ignores a popstate that leaves its entry on top', () => {
    const onClose = vi.fn()
    renderHook(() => useHistoryClose(onClose))
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('takes its entry off when unmounted without closing', async () => {
    const onClose = vi.fn()
    const view = renderHook(() => useHistoryClose(onClose))
    const pop = popped()
    view.unmount()
    expect(viewerClosing()).toBe(true)
    await pop
    expect(viewerClosing()).toBe(false)
    expect(viewerOnTop()).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not go back on unmount after closing', async () => {
    const back = vi.spyOn(window.history, 'back')
    const onClose = vi.fn()
    const view = renderHook(() => useHistoryClose(onClose))
    const pop = popped()
    window.history.back()
    await pop
    expect(onClose).toHaveBeenCalledTimes(1)
    view.unmount()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('does not go back on unmount when another entry is on top', () => {
    const back = vi.spyOn(window.history, 'back')
    const view = renderHook(() => useHistoryClose(vi.fn()))
    window.history.pushState({ other: 1 }, '', '/#/s/main/1')
    view.unmount()
    expect(back).not.toHaveBeenCalled()
  })
})

describe('onViewerEntryGone', () => {
  it('tells once the entry is gone, by Back or by closing, until turned off', async () => {
    const gone = vi.fn()
    const off = onViewerEntryGone(gone)
    renderHook(() => useHistoryClose(vi.fn()))
    let pop = popped()
    window.history.back()
    await pop
    expect(gone).toHaveBeenCalledTimes(1)

    const { result } = renderHook(() => useHistoryClose(vi.fn()))
    pop = popped()
    act(() => result.current())
    await pop
    expect(gone).toHaveBeenCalledTimes(2)

    off()
    renderHook(() => useHistoryClose(vi.fn()))
    pop = popped()
    window.history.back()
    await pop
    expect(gone).toHaveBeenCalledTimes(2)
  })

  it('says nothing for a popstate that is not a viewer’s', () => {
    const gone = vi.fn()
    const off = onViewerEntryGone(gone)
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(gone).not.toHaveBeenCalled()
    off()
  })
})

describe('dropStaleViewerEntry', () => {
  it('drops the mark a reload left, keeping the rest of the state', () => {
    window.history.replaceState({ app: 1, [KEY]: 'old' }, '')
    expect(viewerOnTop()).toBe(true)
    dropStaleViewerEntry()
    expect(state()).toEqual({ app: 1 })
    expect(viewerOnTop()).toBe(false)
  })

  it('leaves an entry without the mark alone', () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    window.history.replaceState(null, '')
    replace.mockClear()
    dropStaleViewerEntry()
    expect(replace).not.toHaveBeenCalled()
  })
})

describe('viewerOnTop', () => {
  it('is false with no state at all', async () => {
    window.history.replaceState(null, '')
    await waitFor(() => expect(viewerOnTop()).toBe(false))
  })
})
