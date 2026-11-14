import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentHistory } from './use-agent-history'
import type { HistorySession } from './use-mux-api'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const session = (id: string, extra: Partial<HistorySession> = {}) =>
  ({
    agent: 'claude',
    id,
    title: id,
    titleSource: 'ai',
    cwd: '',
    updatedAt: '2026-11-14T10:00:00Z',
    ...extra,
  }) as HistorySession

let replies: Array<() => Response | Promise<Response>>
let urls: string[]

beforeEach(() => {
  replies = []
  urls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url)
      const r = replies.shift()
      return r ? r() : json(500, {})
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('useAgentHistory', () => {
  it('reads nothing without a pane', () => {
    const { result } = renderHook(() => useAgentHistory(undefined))
    expect(result.current.loaded).toBe(false)
    expect(urls).toEqual([])
  })

  it('loads a page, more pages, and marks a row live', async () => {
    replies.push(() =>
      json(200, { sessions: [session('a')], next: 'c1', truncated: true }),
    )
    const { result } = renderHook(() => useAgentHistory('p1'))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.sessions.map((s) => s.id)).toEqual(['a'])
    expect(result.current.hasMore).toBe(true)
    expect(result.current.truncated).toBe(true)
    expect(urls[0]).toContain('/panes/p1/agent/history')

    replies.push(() => json(200, { sessions: [session('b')], truncated: true }))
    act(() => result.current.loadMore())
    expect(result.current.loadingMore).toBe(true)
    // A second request while one runs is not sent
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.loadingMore).toBe(false))
    expect(result.current.sessions.map((s) => s.id)).toEqual(['a', 'b'])
    expect(urls[1]).toContain('cursor=c1')
    expect(urls).toHaveLength(2)
    expect(result.current.hasMore).toBe(false)
    // Nothing more to load
    act(() => result.current.loadMore())
    expect(urls).toHaveLength(2)

    act(() => result.current.setLive('b', { tabId: 't', paneId: 'p' }))
    expect(result.current.sessions[1].live).toEqual({ tabId: 't', paneId: 'p' })
    expect(result.current.sessions[0].live).toBeUndefined()
  })

  it('tells a view-only refusal from a failure, and retries', async () => {
    replies.push(() => json(403, { code: 'view_only' }))
    const { result } = renderHook(() => useAgentHistory('p1'))
    await waitFor(() => expect(result.current.error).toBe('view-only'))
    replies.push(() => json(500, {}))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.error).toBe('failed'))
    replies.push(() => Promise.reject(new TypeError('offline')))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.error).toBe('failed'))
  })

  it('keeps what it has when a next page fails', async () => {
    replies.push(() =>
      json(200, { sessions: [session('a')], next: 'c1', truncated: false }),
    )
    const { result } = renderHook(() => useAgentHistory('p1'))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    replies.push(() => json(500, {}))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.error).toBe('failed'))
    expect(result.current.sessions).toHaveLength(1)
  })

  it('drops a next page failing after the pane changed', async () => {
    replies.push(() =>
      json(200, { sessions: [session('a')], next: 'c1', truncated: false }),
    )
    const { result, rerender } = renderHook(({ id }) => useAgentHistory(id), {
      initialProps: { id: 'p1' },
    })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    let fail!: (r: Response) => void
    replies.push(() => new Promise((r) => (fail = r)))
    act(() => result.current.loadMore())
    replies.push(() => json(200, { sessions: [], truncated: false }))
    rerender({ id: 'p2' })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    fail(json(500, {}))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.error).toBeUndefined()
  })

  it('drops replies for a pane it no longer shows', async () => {
    let release!: (r: Response) => void
    replies.push(() => new Promise((r) => (release = r)))
    replies.push(() =>
      json(200, { sessions: [session('two')], next: 'n', truncated: false }),
    )
    const { result, rerender } = renderHook(({ id }) => useAgentHistory(id), {
      initialProps: { id: 'p1' },
    })
    rerender({ id: 'p2' })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    release(json(200, { sessions: [session('one')], truncated: false }))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.sessions.map((s) => s.id)).toEqual(['two'])

    // A page and a failure that come back after the pane changed
    let more!: (r: Response) => void
    replies.push(() => new Promise((r) => (more = r)))
    act(() => result.current.loadMore())
    let failed!: (r: Response) => void
    replies.push(() => new Promise((r) => (failed = r)))
    rerender({ id: 'p3' })
    more(json(200, { sessions: [session('late')], truncated: false }))
    failed(json(403, { code: 'view_only' }))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.sessions.map((s) => s.id)).not.toContain('late')
    expect(result.current.error).toBeUndefined()

    let gone!: (r: Response) => void
    replies.push(() => new Promise((r) => (gone = r)))
    rerender({ id: 'p4' })
    replies.push(() => json(200, { sessions: [], truncated: false }))
    rerender({ id: 'p5' })
    gone(json(500, {}))
    await new Promise((r) => setTimeout(r, 0))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.error).toBeUndefined()
  })
})
