import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHistoryTranscript } from './use-history-transcript'
import type { TranscriptEntry } from './use-mux-api'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const entry = (id: string): TranscriptEntry => ({
  id,
  role: 'user',
  parts: [{ kind: 'text', text: id }],
})

const page = (ids: string[], extra: object = {}) => ({
  agent: 'claude',
  sessionId: 's',
  status: '',
  entries: ids.map(entry),
  cursor: 'c',
  reset: true,
  ...extra,
})

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

const ID = 'aaaaaaaa-0000-4000-8000-000000000001'

describe('useHistoryTranscript', () => {
  it('reads the end, then older pages', async () => {
    replies.push(() => json(200, page(['c', 'd'], { before: 'b1' })))
    const { result } = renderHook(() =>
      useHistoryTranscript('p1', 'claude', ID),
    )
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(urls[0]).toContain(
      `/panes/p1/agent/history/${ID}/transcript?agent=claude`,
    )
    expect(result.current.entries.map((e) => e.id)).toEqual(['c', 'd'])
    expect(result.current.hasOlder).toBe(true)

    replies.push(() => json(200, page(['b'], { reset: false })))
    act(() => result.current.loadOlder())
    expect(result.current.loadingOlder).toBe(true)
    act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.loadingOlder).toBe(false))
    expect(urls[1]).toContain('before=b1')
    expect(urls).toHaveLength(2)
    expect(result.current.entries.map((e) => e.id)).toEqual(['b', 'c', 'd'])
    expect(result.current.hasOlder).toBe(false)
    act(() => result.current.loadOlder())
    expect(urls).toHaveLength(2)
  })

  it('starts over when the file changed, and keeps going on a failure', async () => {
    replies.push(() => json(200, page(['x'], { before: 'b1' })))
    const { result } = renderHook(() => useHistoryTranscript('p1', 'codex', ID))
    await waitFor(() => expect(result.current.loaded).toBe(true))
    replies.push(() => json(500, {}))
    act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.loadingOlder).toBe(false))
    expect(result.current.entries.map((e) => e.id)).toEqual(['x'])
    replies.push(() => json(200, page(['new'], { before: 'b2' })))
    act(() => result.current.loadOlder())
    await waitFor(() => expect(result.current.entries[0].id).toBe('new'))
    expect(result.current.hasOlder).toBe(true)
  })

  it('tells a gone session from a failure', async () => {
    replies.push(() => json(404, { code: 'session_not_found' }))
    const { result, rerender } = renderHook(
      ({ id }) => useHistoryTranscript('p1', 'claude', id),
      { initialProps: { id: ID } },
    )
    await waitFor(() => expect(result.current.error).toBe('gone'))
    replies.push(() => json(500, {}))
    rerender({ id: `${ID.slice(0, -1)}2` })
    await waitFor(() => expect(result.current.error).toBe('failed'))
  })

  it('drops replies of a session it no longer shows', async () => {
    let first!: (r: Response) => void
    let firstFail!: (r: Response) => void
    replies.push(() => new Promise((r) => (first = r)))
    const { result, rerender } = renderHook(
      ({ id }) => useHistoryTranscript('p1', 'claude', id),
      { initialProps: { id: 'one' } },
    )
    replies.push(() => new Promise((r) => (firstFail = r)))
    rerender({ id: 'two' })
    replies.push(() => json(200, page(['three'], { before: 'b' })))
    rerender({ id: 'three' })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    first(json(200, page(['one'])))
    firstFail(json(404, {}))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.entries.map((e) => e.id)).toEqual(['three'])
    expect(result.current.error).toBeUndefined()

    let older!: (r: Response) => void
    replies.push(() => new Promise((r) => (older = r)))
    act(() => result.current.loadOlder())
    replies.push(() => json(200, page(['four'])))
    rerender({ id: 'four' })
    await waitFor(() => expect(result.current.entries[0]?.id).toBe('four'))
    older(json(200, page(['stale'], { reset: false })))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current.entries.map((e) => e.id)).toEqual(['four'])
    expect(result.current.loadingOlder).toBe(false)
  })
})
