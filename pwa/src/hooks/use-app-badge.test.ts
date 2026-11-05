import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import { useAppBadge } from './use-app-badge'

// navigator with the Badging API, recording each call
function stubBadge() {
  const set = vi.fn(async (_n?: number) => {})
  const clear = vi.fn(async () => {})
  Object.defineProperty(navigator, 'setAppBadge', {
    configurable: true,
    value: set,
  })
  Object.defineProperty(navigator, 'clearAppBadge', {
    configurable: true,
    value: clear,
  })
  return { set, clear }
}

function unstubBadge() {
  Reflect.deleteProperty(navigator, 'setAppBadge')
  Reflect.deleteProperty(navigator, 'clearAppBadge')
}

const blocked = (id: string): Session => ({
  id,
  name: id,
  icon: '',
  description: '',
  agentStatus: 'blocked',
})

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useAppBadge', () => {
  let badge: ReturnType<typeof stubBadge>
  beforeEach(() => {
    badge = stubBadge()
    vi.stubGlobal('caches', undefined)
  })
  afterEach(() => {
    unstubBadge()
    vi.unstubAllGlobals()
    setVisibility('visible')
  })

  it('sets the count after every poll, the same count too', () => {
    const { rerender } = renderHook((p) => useAppBadge(p), {
      initialProps: { sessions: [blocked('a')], enabled: true },
    })
    expect(badge.set).toHaveBeenLastCalledWith(1)
    // A new array with the same count: set again (the worker may have
    // changed it)
    rerender({ sessions: [blocked('a')], enabled: true })
    expect(badge.set).toHaveBeenCalledTimes(2)
    rerender({ sessions: [], enabled: true })
    expect(badge.clear).toHaveBeenCalledTimes(1)
  })

  it('clears it while turned off, and keeps the setting', async () => {
    const put = vi.fn(async () => {})
    vi.stubGlobal('caches', { open: async () => ({ put }) })
    const sessions = [blocked('a'), blocked('b')]
    const { rerender } = renderHook((p) => useAppBadge(p), {
      initialProps: { sessions, enabled: false },
    })
    expect(badge.set).not.toHaveBeenCalled()
    expect(badge.clear).toHaveBeenCalled()
    rerender({ sessions, enabled: true })
    expect(badge.set).toHaveBeenLastCalledWith(2)
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(2))
  })

  it('sets it again when the page shows, not when it hides', () => {
    const { unmount } = renderHook(() =>
      useAppBadge({ sessions: [blocked('a')], enabled: true }),
    )
    badge.set.mockClear()
    setVisibility('hidden')
    expect(badge.set).not.toHaveBeenCalled()
    setVisibility('visible')
    expect(badge.set).toHaveBeenCalledWith(1)
    unmount()
    badge.set.mockClear()
    setVisibility('visible')
    expect(badge.set).not.toHaveBeenCalled()
  })
})
