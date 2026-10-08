import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  READY_UNSEEN_MS,
  START_GIVE_UP_MS,
  START_POLL_MS,
  type StartAgentOptions,
  useStartAgent,
} from './use-start-agent'

const PANE = 'w1:p1'

// Replies of the fake server, in order: the POST's, then each GET's.
let postReply: { status: number; body: unknown }
let getReplies: { status: number; body: unknown }[]
let requests: { method: string; url: string; body?: string }[]

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

beforeEach(() => {
  vi.useFakeTimers()
  postReply = { status: 200, body: { ok: true, state: 'starting' } }
  getReplies = []
  requests = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      requests.push({ method, url, body: init?.body as string | undefined })
      if (method === 'POST') return json(postReply.status, postReply.body)
      const r = getReplies.shift() ?? {
        status: 200,
        body: { kind: 'claude', state: 'starting' },
      }
      return json(r.status, r.body)
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(activePaneId = PANE) {
  const opts = {
    activePaneId,
    showView: vi.fn<StartAgentOptions['showView']>(),
    notify: vi.fn<StartAgentOptions['notify']>(),
  }
  const hook = renderHook(
    ({ agentPanes }) => useStartAgent({ ...opts, agentPanes }),
    { initialProps: { agentPanes: new Set<string>() } },
  )
  // The snapshot shows these panes running an agent
  const snapshot = (...panes: string[]) =>
    hook.rerender({ agentPanes: new Set(panes) })
  return { ...hook, opts, snapshot }
}

// Lets pending promises (fetch, json) settle.
const settle = () => act(async () => {})
const poll = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(START_POLL_MS)
  })

describe('useStartAgent', () => {
  it('sends exactly the kind, then follows the start', async () => {
    const { result } = setup()
    act(() => result.current.start(PANE, 'codex'))
    expect(result.current.starts[PANE]).toMatchObject({
      kind: 'codex',
      phase: 'sending',
    })
    await settle()
    expect(requests[0]).toEqual({
      method: 'POST',
      url: '/api/mux/panes/w1%3Ap1/agent/start',
      body: '{"kind":"codex"}',
    })
    expect(result.current.starts[PANE].phase).toBe('starting')
    getReplies = [{ status: 200, body: { kind: 'codex', state: 'starting' } }]
    await poll()
    expect(requests[1].method).toBe('GET')
    expect(result.current.starts[PANE].phase).toBe('starting')
  })

  it('stays on the Chat view when Claude Code is ready', async () => {
    const { result, opts } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    getReplies = [{ status: 200, body: { kind: 'claude', state: 'ready' } }]
    await poll()
    expect(result.current.starts[PANE]).toMatchObject({
      kind: 'claude',
      phase: 'ready',
    })
    expect(opts.showView).not.toHaveBeenCalled()
    expect(opts.notify).not.toHaveBeenCalled()
    // Ready: no more polls
    const n = requests.length
    await poll()
    expect(requests.length).toBe(n)
  })

  it('keeps a ready Codex for its first-message guidance', async () => {
    const { result } = setup()
    act(() => result.current.start(PANE, 'codex'))
    await settle()
    getReplies = [{ status: 200, body: { kind: 'codex', state: 'ready' } }]
    await poll()
    expect(result.current.starts[PANE]).toMatchObject({
      kind: 'codex',
      phase: 'ready',
    })
  })

  it('opens the terminal when the agent asks something first', async () => {
    const { result, opts } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    getReplies = [{ status: 200, body: { kind: 'claude', state: 'blocked' } }]
    await poll()
    expect(opts.showView).toHaveBeenCalledWith('terminal')
    expect(opts.notify).toHaveBeenCalledWith(
      'Claude Code is asking something in the terminal.',
    )
    expect(result.current.starts[PANE]).toBeUndefined()
  })

  it('warns, with a way to the terminal, when the agent did not start', async () => {
    for (const state of ['exited', 'timeout']) {
      const { result, opts, unmount } = setup()
      act(() => result.current.start(PANE, 'claude'))
      await settle()
      getReplies = [{ status: 200, body: { kind: 'claude', state } }]
      await poll()
      expect(result.current.starts[PANE]).toBeUndefined()
      const [message, options] = opts.notify.mock.calls[0]
      expect(message).toBe(
        'Claude Code did not start. Open the terminal to see why.',
      )
      expect(options?.variant).toBe('warning')
      options?.action?.onClick()
      expect(opts.showView).toHaveBeenCalledWith('terminal')
      unmount()
    }
  })

  it('never switches the view of another pane', async () => {
    const { result, opts } = setup('w1:p2')
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    getReplies = [{ status: 200, body: { kind: 'claude', state: 'blocked' } }]
    await poll()
    expect(opts.showView).not.toHaveBeenCalled()
    expect(opts.notify).toHaveBeenCalledWith(
      "Claude Code is asking something in another pane's terminal.",
    )
  })

  it("follows another device's start (409 starting) under its kind", async () => {
    postReply = { status: 409, body: { code: 'starting', error: 'x' } }
    const { result } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    expect(result.current.starts[PANE].phase).toBe('starting')
    getReplies = [{ status: 200, body: { kind: 'codex', state: 'ready' } }]
    await poll()
    expect(result.current.starts[PANE]).toMatchObject({
      kind: 'codex',
      phase: 'ready',
    })
  })

  it('follows a start whose answer timed out (start_unknown)', async () => {
    postReply = { status: 504, body: { code: 'start_unknown', error: 'x' } }
    const { result } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    expect(result.current.starts[PANE].phase).toBe('starting')
  })

  it('stops following when the server has no start (404)', async () => {
    const { result } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    getReplies = [{ status: 404, body: { code: 'no_start', error: 'x' } }]
    await poll()
    expect(result.current.starts[PANE]).toMatchObject({
      kind: 'claude',
      phase: 'failed',
      error: 'Could not start the agent.',
    })
    const n = requests.length
    await poll()
    expect(requests.length).toBe(n)
  })

  it.each([
    [
      'pane_busy',
      409,
      'This pane is running something. Start the agent in a pane that shows only its shell.',
    ],
    [
      'unsupported',
      501,
      'This Herdr cannot start agents. Update Herdr to 0.8.2 or later.',
    ],
    ['not_found', 404, 'This pane is gone.'],
    [
      'start_pending',
      409,
      'Herdr still holds the last start in this pane for up to 30 seconds. Try again shortly.',
    ],
    ['start_failed', 500, 'Could not start the agent.'],
  ])('says why a start was refused (%s)', async (code, status, message) => {
    postReply = { status, body: { code, error: 'server text' } }
    const { result } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    expect(result.current.starts[PANE]).toMatchObject({
      kind: 'claude',
      phase: 'failed',
      error: message,
    })
    await poll()
    expect(requests.filter((r) => r.method === 'GET')).toHaveLength(0)
  })

  it('says a refused Codex start is about Codex, not the Herdr version', async () => {
    postReply = { status: 501, body: { code: 'unsupported', error: 'x' } }
    const { result } = setup()
    act(() => result.current.start(PANE, 'codex'))
    await settle()
    expect(result.current.starts[PANE]).toMatchObject({
      phase: 'failed',
      error: 'This server cannot start Codex.',
    })
  })

  it('keeps a ready start while its agent runs, forgets it once gone', async () => {
    const { result, snapshot } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    getReplies = [{ status: 200, body: { kind: 'claude', state: 'ready' } }]
    await poll()
    snapshot(PANE)
    expect(result.current.starts[PANE]).toMatchObject({
      phase: 'ready',
      seen: true,
    })
    // Past the unseen limit: kept, the agent was seen
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READY_UNSEEN_MS + 1000)
    })
    expect(result.current.starts[PANE]?.phase).toBe('ready')
    // /exit: the pane is back at its shell, the Chat view offers a start
    snapshot()
    expect(result.current.starts[PANE]).toBeUndefined()
  })

  it('forgets a ready start whose agent the snapshot never showed', async () => {
    const { result, snapshot } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    // Snapshots while it starts change nothing
    snapshot('w1:p9')
    expect(result.current.starts[PANE]?.phase).toBe('starting')
    getReplies = [{ status: 200, body: { kind: 'claude', state: 'ready' } }]
    await poll()
    snapshot('w1:p8')
    expect(result.current.starts[PANE]).toMatchObject({ phase: 'ready' })
    expect(result.current.starts[PANE].seen).toBeUndefined()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READY_UNSEEN_MS)
    })
    expect(result.current.starts[PANE]).toBeUndefined()
  })

  it('stops following when the server will not answer the start', async () => {
    const { result } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    getReplies = [{ status: 501, body: { code: 'unsupported', error: 'x' } }]
    await poll()
    expect(result.current.starts[PANE]).toMatchObject({
      phase: 'failed',
      error: 'Could not follow the start. Open the terminal to check.',
    })
  })

  it('gives up on a start that never ends', async () => {
    const { result } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    // Every read answers starting (the default reply)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_GIVE_UP_MS + START_POLL_MS)
    })
    expect(result.current.starts[PANE]).toMatchObject({ phase: 'failed' })
    const n = requests.length
    await poll()
    expect(requests.length).toBe(n)
  })

  it('tells how a start in another pane went, without switching view', async () => {
    for (const [state, message, action] of [
      ['ready', 'Claude Code is ready in another pane.', false],
      ['exited', 'Claude Code did not start in another pane.', false],
    ] as const) {
      const { result, opts, unmount } = setup('w1:p2')
      act(() => result.current.start(PANE, 'claude'))
      await settle()
      getReplies = [{ status: 200, body: { kind: 'claude', state } }]
      await poll()
      const [got, options] = opts.notify.mock.calls[0]
      expect(got).toBe(message)
      expect(!!options?.action).toBe(action)
      expect(opts.showView).not.toHaveBeenCalled()
      unmount()
    }
  })

  it('never reads one start twice at once, and retries a network failure', async () => {
    const { result } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    // The first read hangs past the next poll
    let release: (r: Response) => void = () => {}
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((r) => (release = r)),
    )
    await poll()
    await poll()
    expect(requests.length).toBe(1) // the POST; the hanging read is not logged
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await act(async () =>
      release(json(200, { kind: 'claude', state: 'starting' })),
    )
    // A network failure keeps following
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await poll()
    expect(result.current.starts[PANE].phase).toBe('starting')
  })

  it('reads at once when the page is shown again', async () => {
    const { result } = setup()
    act(() => result.current.start(PANE, 'claude'))
    await settle()
    const fetchMock = vi.mocked(fetch)
    const calls = fetchMock.mock.calls.length
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(fetchMock.mock.calls.length).toBe(calls)
    visibility.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(fetchMock.mock.calls.length).toBe(calls + 1)
    visibility.mockRestore()
  })
})
