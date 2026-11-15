import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptEntry } from '../hooks/use-mux-api'
import { HistoryTranscriptView } from './history-transcript-view'

const ID = 'aaaaaaaa-0000-4000-8000-000000000001'

const entry = (
  id: string,
  text: string,
  role: TranscriptEntry['role'] = 'user',
): TranscriptEntry => ({
  id,
  role,
  ts: '2026-11-14T10:00:00Z',
  parts: [{ kind: 'text', text }],
})

const tool = (id: string): TranscriptEntry => ({
  id,
  role: 'assistant',
  ts: '2026-11-14T10:00:01Z',
  parts: ['a', 'b', 'c', 'd'].map((k) => ({
    kind: 'tool' as const,
    tool: 'Bash',
    toolId: `${k}-${id}`,
    input: `echo ${k}`,
  })),
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

let replies: Array<() => Response | Promise<Response>>

beforeEach(() => {
  replies = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (replies.shift() ?? (() => json(500, {})))()),
  )
})

afterEach(() => vi.unstubAllGlobals())

const view = () =>
  render(
    <HistoryTranscriptView
      paneId="p1"
      agent="claude"
      sessionId={ID}
      notify={vi.fn()}
      openFile={vi.fn()}
    />,
  )

describe('HistoryTranscriptView', () => {
  it('opens at the end and keeps the place as older entries come', async () => {
    replies.push(() =>
      json(200, {
        entries: [
          entry('a', 'hello'),
          tool('t'),
          entry('b', 'done', 'assistant'),
        ],
        before: 'b1',
        reset: true,
      }),
    )
    let height = 500
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      () => height,
    )
    view()
    expect(screen.getByText('Loading the conversation…')).toBeTruthy()
    const list = await screen.findByTestId('history-transcript')
    expect(list.scrollTop).toBe(500)
    expect(screen.getByText('hello')).toBeTruthy()
    // A run of tools folds and opens on request
    const run = screen.getByText(/4 commands/).closest('button') as HTMLElement
    const was = run.getAttribute('aria-expanded')
    fireEvent.click(run)
    expect(
      (
        screen.getByText(/4 commands/).closest('button') as HTMLElement
      ).getAttribute('aria-expanded'),
    ).not.toBe(was)

    let release!: (r: Response) => void
    replies.push(() => new Promise((r) => (release = r)))
    list.scrollTop = 100
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeTruthy()
    height = 800
    await act(async () =>
      release(json(200, { entries: [entry('z', 'older one')], reset: false })),
    )
    expect(screen.getByText('older one')).toBeTruthy()
    expect(list.scrollTop).toBe(400)
    expect(
      screen.queryByRole('button', { name: 'Show earlier messages' }),
    ).toBeNull()
  })

  it('says an empty conversation, a gone session and a failure', async () => {
    replies.push(() => json(200, { entries: [], reset: true }))
    const first = view()
    expect(await screen.findByText('No messages yet.')).toBeTruthy()
    first.unmount()
    replies.push(() => json(404, { code: 'session_not_found' }))
    const second = view()
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This session is no longer there.',
    )
    second.unmount()
    replies.push(() => json(500, {}))
    view()
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not read the conversation.',
    )
  })
})
