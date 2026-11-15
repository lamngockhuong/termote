import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HistorySession } from './use-mux-api'
import { useResumeSession } from './use-resume-session'

const S: HistorySession = {
  agent: 'claude',
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  title: 'Login',
  titleSource: 'ai',
  cwd: '',
  updatedAt: '2026-11-14T10:00:00Z',
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => vi.unstubAllGlobals())

function setup(reply: () => Promise<Response>) {
  const fetch = vi.fn((_url: string, _init?: RequestInit) => reply())
  vi.stubGlobal('fetch', fetch)
  const opts = { notify: vi.fn(), onResumed: vi.fn(), onLive: vi.fn() }
  const hook = renderHook(() => useResumeSession(opts))
  return { ...opts, fetch, hook }
}

describe('useResumeSession', () => {
  it('sends one resume at a time and reports where it runs', async () => {
    let release!: (r: Response) => void
    const { fetch, hook, onResumed, notify } = setup(
      () => new Promise((r) => (release = r)),
    )
    let done!: Promise<void>
    act(() => {
      done = hook.result.current.resume('p1', S, 'tab', true)
    })
    expect(hook.result.current.pending).toBe(S.id)
    // Another while it runs is not sent
    await act(() => hook.result.current.resume('p1', S, 'here'))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toMatchObject({
      where: 'tab',
      fork: true,
    })
    await act(async () => {
      release(json(200, { ok: true, tabId: 't', paneId: 'p' }))
      await done
    })
    expect(onResumed).toHaveBeenCalledWith(
      { ok: true, tabId: 't', paneId: 'p' },
      'tab',
    )
    expect(notify).not.toHaveBeenCalled()
    expect(hook.result.current.pending).toBeUndefined()
  })

  it('marks a session running elsewhere, and tells every refusal', async () => {
    const { hook, onLive, notify, fetch } = setup(async () =>
      json(409, { code: 'session_live', tabId: 't9', paneId: 'p9' }),
    )
    await act(() => hook.result.current.resume('p1', S, 'here'))
    expect(
      JSON.parse(fetch.mock.calls[0][1]?.body as string),
    ).not.toHaveProperty('fork')
    expect(onLive).toHaveBeenCalledWith(S.id, { tabId: 't9', paneId: 'p9' })
    expect(notify).toHaveBeenCalledWith(
      'This session is running in another tab',
      { variant: 'danger' },
    )
  })

  it('says a refusal without its tab, a timeout and a network failure', async () => {
    let reply: () => Promise<Response> = async () =>
      json(409, { code: 'session_live' })
    const { hook, onLive, notify } = setup(() => reply())
    await act(() => hook.result.current.resume('p1', S, 'tab'))
    expect(onLive).not.toHaveBeenCalled()
    reply = async () => json(409, { code: 'pane_busy' })
    await act(() => hook.result.current.resume('p1', S, 'here'))
    expect(notify).toHaveBeenLastCalledWith(
      'The pane is running something other than its shell',
      { variant: 'danger' },
    )
    reply = () => Promise.reject(new DOMException('slow', 'TimeoutError'))
    await act(() => hook.result.current.resume('p1', S, 'tab'))
    expect(notify).toHaveBeenLastCalledWith('It took too long. Try again', {
      variant: 'danger',
    })
    reply = () => Promise.reject(new TypeError('offline'))
    await act(() => hook.result.current.resume('p1', S, 'tab'))
    expect(notify).toHaveBeenLastCalledWith(
      'The server could not finish this. Try again',
      { variant: 'danger' },
    )
  })

  it('works without a live handler', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(409, { code: 'session_live', tabId: 't', paneId: 'p' }),
      ),
    )
    const notify = vi.fn()
    const { result } = renderHook(() =>
      useResumeSession({ notify, onResumed: vi.fn() }),
    )
    await act(() => result.current.resume('p1', S, 'tab'))
    expect(notify).toHaveBeenCalled()
  })
})
