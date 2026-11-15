import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionUsage } from './use-session-usage'
import { USAGE_POLL, useUsageSummary } from './use-usage-summary'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const SUMMARY = {
  buckets: [{ t: '2026-11-15T10:00:00Z', agent: 'claude', tokens: 5 }],
  since: '2026-11-07T10:00:00Z',
  truncated: false,
  pricesUpdated: '2026-11-15',
}

let replies: Array<() => Response | Promise<Response>>
let urls: string[]

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  })
}

beforeEach(() => {
  replies = []
  urls = []
  setHidden(false)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      const r = replies.shift()
      return r ? r() : json(500, {})
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  setHidden(false)
})

describe('useUsageSummary', () => {
  it("reads the machine's totals, then every minute while shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    replies.push(() => json(200, SUMMARY))
    const { result, unmount } = renderHook(() => useUsageSummary())
    await waitFor(() => expect(result.current.summary).toEqual(SUMMARY))
    expect(urls[0]).toMatch(/\/api\/mux\/usage$/)

    // A failed read keeps the totals read before.
    await act(async () => {
      vi.advanceTimersByTime(USAGE_POLL)
    })
    await waitFor(() => expect(result.current.error).toBe('failed'))
    expect(result.current.summary).toEqual(SUMMARY)

    // Hidden: no read until shown again.
    setHidden(true)
    await act(async () => {
      vi.advanceTimersByTime(USAGE_POLL)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(urls).toHaveLength(2)
    replies.push(() => json(200, SUMMARY))
    setHidden(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(result.current.error).toBeUndefined())
    expect(urls).toHaveLength(3)
    unmount()
  })

  it("reads a pane's folder, view-only refused, or nothing when off", async () => {
    replies.push(() => json(403, { code: 'view_only', error: 'view-only' }))
    const { result } = renderHook(() => useUsageSummary('w1:p1'))
    await waitFor(() => expect(result.current.error).toBe('view-only'))
    expect(urls[0]).toContain('/panes/w1%3Ap1/agent/usage/summary')

    const off = renderHook(() => useUsageSummary('p', false))
    expect(off.result.current).toEqual({})
    expect(urls).toHaveLength(1)
  })

  it('drops a reply that comes after unmount', async () => {
    let resolve: (r: Response) => void = () => {}
    replies.push(() => new Promise((r) => (resolve = r)))
    replies.push(() => new Promise((r) => (resolve = r)))
    const { result, unmount } = renderHook(() => useUsageSummary())
    unmount()
    resolve(json(200, SUMMARY))
    await act(async () => {})
    expect(result.current).toEqual({})
    const second = renderHook(() => useUsageSummary())
    second.unmount()
    resolve(json(500, {}))
    await act(async () => {})
    expect(second.result.current).toEqual({})
  })
})

describe('useSessionUsage', () => {
  it('reads an old session once, nothing on failure', async () => {
    const usage = { tokens: { total: 9 }, models: [], pricesUpdated: 'x' }
    replies.push(() => json(200, usage))
    const { result, rerender } = renderHook(
      ({ id }) => useSessionUsage('p1', 'codex', id),
      { initialProps: { id: 'a' } },
    )
    await waitFor(() => expect(result.current).toEqual(usage))
    expect(urls[0]).toContain('/panes/p1/agent/usage?agent=codex&session=a')
    rerender({ id: 'b' })
    expect(result.current).toBeUndefined()
    await act(async () => {})
    expect(result.current).toBeUndefined()
  })

  it('drops a reply that comes after unmount', async () => {
    let resolve: (r: Response) => void = () => {}
    replies.push(() => new Promise((r) => (resolve = r)))
    const { result, unmount } = renderHook(() =>
      useSessionUsage('p1', 'claude', 'a'),
    )
    unmount()
    resolve(json(200, { tokens: { total: 1 } }))
    await act(async () => {})
    expect(result.current).toBeUndefined()
  })
})
