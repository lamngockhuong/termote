import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POLL_INTERVAL } from '../hooks/use-agent-transcript'
import type {
  SubagentNode,
  Subagents,
  TranscriptEntry,
} from '../hooks/use-mux-api'
import { resetSubagentTranscriptStores } from '../hooks/use-subagent-transcript'

const tree = vi.hoisted(() => ({
  value: undefined as Subagents | undefined,
  reads: [] as Array<[string, boolean]>,
}))
vi.mock('../hooks/use-subagents', () => ({
  useSubagents: (pane: string, open: boolean) => {
    tree.reads.push([pane, open])
    return { tree: tree.value, error: false }
  },
}))

import {
  type SubagentTarget,
  SubagentTranscriptSheet,
} from './subagent-transcript-sheet'

const START = Date.parse('2026-11-23T10:00:00Z')

const node = (over: Partial<SubagentNode> = {}): SubagentNode => ({
  id: 'a1',
  type: 'code-reviewer',
  description: 'Review the parser',
  status: 'running',
  startTs: '2026-11-23T09:59:00Z',
  tokens: 12_300,
  depth: 1,
  children: [],
  ...over,
})

const entry = (id: string, text: string): TranscriptEntry => ({
  id,
  role: 'assistant',
  ts: '2026-11-23T10:00:00Z',
  parts: [{ kind: 'text', text }],
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const page = (entries: TranscriptEntry[], over: object = {}) =>
  json(200, {
    agent: 'claude',
    sessionId: 's',
    status: 'unknown',
    entries,
    cursor: `c${entries.length}`,
    reset: true,
    ...over,
  })

let replies: Array<() => Response | Promise<Response>>
let urls: string[]

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn().mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
  vi.useFakeTimers({ now: START })
  resetSubagentTranscriptStores()
  tree.value = undefined
  tree.reads = []
  replies = []
  urls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      urls.push(u)
      return (replies.shift() ?? (() => page([], { reset: false })))()
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const tick = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

const sheet = (target?: SubagentTarget, onClose = vi.fn()) =>
  render(
    <SubagentTranscriptSheet
      target={target}
      onClose={onClose}
      notify={vi.fn()}
      clockOffset={0}
    />,
  )

describe('SubagentTranscriptSheet', () => {
  it('reads nothing while closed', () => {
    sheet()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tree.reads.every(([, open]) => !open)).toBe(true)
    expect(urls).toEqual([])
  })

  it('shows a running subagent and follows its conversation', async () => {
    tree.value = { nodes: [node()] }
    replies.push(() => page([entry('e1', 'Reading the parser')]))
    const onClose = vi.fn()
    const { rerender } = sheet({ paneId: 'p1', node: node() }, onClose)
    expect(tree.reads).toContainEqual(['p1', true])
    expect(screen.getByText('Loading the conversation…')).toBeTruthy()
    await tick()
    const dialog = screen.getByRole('dialog', { name: 'code-reviewer' })
    expect(dialog).toHaveTextContent('Review the parser')
    expect(dialog).toHaveTextContent('running · 1 min · ↓ 12k tokens')
    expect(screen.getByText('Reading the parser')).toBeTruthy()
    expect(urls[0]).toBe('/api/mux/panes/p1/agent/subagents/a1/transcript')
    // No input and no action: closing, and copying an answer
    expect(
      screen.getAllByRole('button').map((b) => b.getAttribute('aria-label')),
    ).toEqual(["Close the subagent's conversation", 'Copy answer'])

    // Polled while it runs
    replies.push(() =>
      page([entry('e2', 'Found it')], { reset: false, cursor: 'c2' }),
    )
    await tick(POLL_INTERVAL)
    expect(screen.getByText('Found it')).toBeTruthy()
    expect(urls[1]).toContain('cursor=c1')

    // It ends: read once more, then no more
    tree.value = {
      nodes: [node({ status: 'done', endTs: '2026-11-23T10:00:30Z' })],
    }
    rerender(
      <SubagentTranscriptSheet
        target={{ paneId: 'p1', node: node() }}
        onClose={onClose}
        notify={vi.fn()}
      />,
    )
    await tick()
    expect(dialog).toHaveTextContent('done · 1 min')
    const reads = urls.length
    await tick(POLL_INTERVAL * 4)
    expect(urls).toHaveLength(reads)

    fireEvent.click(
      screen.getByRole('button', { name: "Close the subagent's conversation" }),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps the last node seen once the tree no longer has it', async () => {
    tree.value = { nodes: [node({ tokens: 50_000 })] }
    replies.push(() => page([entry('e1', 'Hello')]))
    const target = { paneId: 'p1', node: node() }
    const { rerender } = sheet(target)
    await tick()
    tree.value = { nodes: [] }
    replies.push(() =>
      json(404, { error: 'no such session', code: 'session_not_found' }),
    )
    rerender(
      <SubagentTranscriptSheet
        target={target}
        onClose={vi.fn()}
        notify={vi.fn()}
      />,
    )
    await tick()
    const dialog = screen.getByRole('dialog')
    // Not said to run any more: nothing reports it
    expect(dialog).toHaveTextContent('done (guessed) · ↓ 50k tokens')
    // What was read stays, under why no more comes
    expect(screen.getByText('Hello')).toBeTruthy()
    expect(screen.getByRole('alert')).toHaveTextContent(
      "This subagent's conversation is no longer there. What was read stays.",
    )
  })

  it('takes the node opened before the tree is read', async () => {
    replies.push(() => page([]))
    sheet({ paneId: 'p1', node: node({ description: undefined }) })
    await tick()
    const dialog = screen.getByRole('dialog', { name: 'code-reviewer' })
    expect(dialog).toHaveTextContent('running')
    expect(screen.getByText('Nothing written yet.')).toBeTruthy()
  })

  it.each([
    [
      404,
      { error: 'no such session', code: 'session_not_found' },
      "This subagent's conversation is no longer there. What was read stays.",
    ],
    [
      404,
      { error: 'not found' },
      "This server cannot show a subagent's conversation yet. Update termote on it.",
    ],
    [
      403,
      { error: 'view-only', code: 'view_only' },
      'Could not read the conversation.',
    ],
  ])('says why there is nothing (%i %o)', async (status, body, said) => {
    tree.value = { nodes: [node({ status: 'done' })] }
    replies.push(() => json(status, body))
    sheet({ paneId: 'p1', node: node({ status: 'done' }) })
    await tick()
    expect(screen.getByRole('alert')).toHaveTextContent(said)
    expect(screen.queryByTestId('subagent-transcript')).toBeNull()
  })

  it('follows the end only for a reader at the end, and loads older entries', async () => {
    tree.value = { nodes: [node()] }
    let height = 500
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      () => height,
    )
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
    replies.push(() => page([entry('e1', 'first')], { before: 'b1' }))
    sheet({ paneId: 'p1', node: node() })
    await tick()
    const list = screen.getByTestId('subagent-transcript')
    expect(list.scrollTop).toBe(500)

    // At the end: a new entry keeps it there
    height = 700
    replies.push(() =>
      page([entry('e2', 'second')], { reset: false, cursor: 'c2' }),
    )
    await tick(POLL_INTERVAL)
    expect(list.scrollTop).toBe(700)

    // Scrolled up: a new entry leaves the place alone
    list.scrollTop = 100
    fireEvent.scroll(list)
    height = 900
    replies.push(() =>
      page([entry('e3', 'third')], { reset: false, cursor: 'c3' }),
    )
    await tick(POLL_INTERVAL)
    expect(screen.getByText('third')).toBeTruthy()
    expect(list.scrollTop).toBe(100)

    // Older entries go above, the entry being read staying in place
    replies.push(() =>
      page([entry('e0', 'zeroth')], { reset: false, before: '' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    height = 1000
    await tick()
    expect(screen.getByText('zeroth')).toBeTruthy()
    expect(list.scrollTop).toBe(200)
  })
})
