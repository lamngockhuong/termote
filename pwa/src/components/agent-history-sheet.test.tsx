import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { viewerClosing } from '../hooks/use-history-close'
import type { HistorySession } from '../hooks/use-mux-api'
import { AgentHistorySheet, type HistoryTarget } from './agent-history-sheet'

// The transcript itself is HistoryTranscriptView's own test: here a stand-in
// that names what it reads and opens a file through the sheet.
vi.mock('./history-transcript-view', () => ({
  HistoryTranscriptView: (p: {
    sessionId: string
    openFile?: (path: string, line?: number) => Promise<void>
  }) => (
    <div>
      <p>transcript of {p.sessionId}</p>
      {p.openFile && (
        <button type="button" onClick={() => p.openFile?.('a.ts', 3)}>
          open file
        </button>
      )}
    </div>
  ),
}))

const session = (
  id: string,
  extra: Partial<HistorySession> = {},
): HistorySession => ({
  agent: 'claude',
  id,
  title: `Title ${id}`,
  titleSource: 'ai',
  cwd: '',
  updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  ...extra,
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

let lists: Array<() => Response | Promise<Response>>
let resumes: Array<() => Response>
let posts: unknown[]

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn().mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
  lists = []
  resumes = []
  posts = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/agent/resume')) {
        posts.push(JSON.parse(init?.body as string))
        return (
          resumes.shift() ?? (() => json(200, { tabId: 't', paneId: 'p' }))
        )()
      }
      return (lists.shift() ?? (() => json(500, {})))()
    }),
  )
})

afterEach(async () => {
  // A sheet left on a session takes its history entry off as it unmounts:
  // wait for that popstate, or it would land in the next test
  cleanup()
  await waitFor(() => expect(viewerClosing()).toBe(false))
  vi.unstubAllGlobals()
})

function setup(
  target: Partial<HistoryTarget> | null = {},
  props: Partial<Parameters<typeof AgentHistorySheet>[0]> = {},
) {
  const handlers = {
    onClose: vi.fn(),
    notify: vi.fn(),
    onResumed: vi.fn(),
    onOpenLive: vi.fn(),
  }
  const t = target && { paneId: 'p1', here: false, ...target }
  const view = render(
    <AgentHistorySheet
      target={t}
      readOnly={false}
      canResume
      {...handlers}
      {...props}
    />,
  )
  return { ...handlers, ...view }
}

const listOf =
  (sessions: HistorySession[], extra: object = {}) =>
  () =>
    json(200, { sessions, truncated: false, ...extra })

describe('AgentHistorySheet', () => {
  it('shows nothing when closed', () => {
    setup(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lists, filters and searches the sessions', async () => {
    lists.push(
      listOf([
        session('a', { branch: 'feat/login' }),
        session('b', { agent: 'codex', title: 'Fix tests' }),
      ]),
    )
    setup()
    expect(screen.getByRole('status').textContent).toBe('Loading sessions…')
    await screen.findByText('Title a')
    expect(screen.getByText('Fix tests')).toBeTruthy()
    // Both agents: a filter for each
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    expect(screen.queryByText('Title a')).toBeNull()
    expect(
      screen
        .getByRole('button', { name: 'Codex' })
        .getAttribute('aria-pressed'),
    ).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    // By title or branch
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'LOGIN' } })
    expect(screen.getByText('Title a')).toBeTruthy()
    expect(screen.queryByText('Fix tests')).toBeNull()
    fireEvent.change(search, { target: { value: 'nothing' } })
    expect(screen.getByText('No session matches.')).toBeTruthy()
    // Enter opens nothing without a match; Escape clears
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.queryByText(/transcript of/)).toBeNull()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect((search as HTMLInputElement).value).toBe('')
    fireEvent.keyDown(search, { key: 'Escape' })
    // Enter opens the first one
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(screen.getByText('transcript of a')).toBeTruthy()
  })

  it('moves between rows with the arrow keys and comes back to the row', async () => {
    lists.push(listOf([session('a'), session('b')]))
    setup()
    await screen.findByText('Title a')
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' })
    const rows = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('data-history-id'))
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1])
    fireEvent.keyDown(rows[1], { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0], { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rows[0])
    fireEvent.keyDown(rows[0], { key: 'x' })
    fireEvent.click(rows[1])
    expect(screen.getByText('transcript of b')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the list' }))
    await waitFor(() =>
      expect(
        (document.activeElement as HTMLElement).getAttribute('data-history-id'),
      ).toBe('b'),
    )
  })

  it('says why there is nothing, and retries a failure', async () => {
    lists.push(() => json(403, { code: 'view_only' }))
    const { unmount } = setup()
    expect((await screen.findByRole('alert')).textContent).toBe(
      'A view-only device reads the history only in a git repository.',
    )
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    unmount()

    lists.push(() => json(500, {}))
    setup()
    await screen.findByText('Could not read the session history.')
    lists.push(listOf([]))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByText('No session ran in this folder yet.')
  })

  it('loads more and says when Codex runs were left out', async () => {
    lists.push(listOf([session('a')], { next: 'c1' }))
    setup()
    await screen.findByText('Title a')
    let release!: (r: Response) => void
    lists.push(() => new Promise((r) => (release = r)))
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeTruthy()
    await act(async () =>
      release(json(200, { sessions: [session('b')], truncated: true })),
    )
    expect(screen.getByText('Title b')).toBeTruthy()
    expect(
      screen.getByText(
        'Only sessions among the latest 2000 Codex runs are shown.',
      ),
    ).toBeTruthy()
  })

  it('resumes in a new tab or here', async () => {
    lists.push(listOf([session('a')]))
    const { onClose, onResumed } = setup({ here: true })
    fireEvent.click(await screen.findByText('Title a'))
    expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
    let release!: () => Response
    resumes.push(() => release())
    release = () => json(200, { tabId: 't2', paneId: 'p2' })
    fireEvent.click(screen.getByRole('button', { name: 'Resume here' }))
    await waitFor(() => expect(onResumed).toHaveBeenCalled())
    expect(posts[0]).toEqual({ agent: 'claude', session: 'a', where: 'here' })
    expect(onClose).toHaveBeenCalled()
    expect(onResumed.mock.calls[0][1]).toBe('here')
  })

  it('shows the resume in progress and a refusal marks the session running', async () => {
    lists.push(listOf([session('a')]))
    const { notify, onOpenLive, onClose } = setup()
    fireEvent.click(await screen.findByText('Title a'))
    expect(screen.queryByRole('button', { name: 'Resume here' })).toBeNull()
    resumes.push(() =>
      json(409, { code: 'session_live', tabId: 't9', paneId: 'p9' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Resume in a new tab' }))
    expect(screen.getByRole('status').textContent).toBe('Resuming…')
    await screen.findByRole('button', { name: 'Open the running tab' })
    expect(notify).toHaveBeenCalled()
    expect(
      screen.getByText(
        'A fork is a new session with its own id; this one stays as it is.',
      ),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }))
    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[1]).toMatchObject({ where: 'tab', fork: true })
    fireEvent.click(
      screen.getByRole('button', { name: 'Open the running tab' }),
    )
    expect(onOpenLive).toHaveBeenCalledWith({ tabId: 't9', paneId: 'p9' })
    expect(onClose).toHaveBeenCalled()
    // Back on the list, the row says it runs
    fireEvent.click(screen.getByRole('button', { name: 'Back to the list' }))
    expect(await screen.findByText('Running')).toBeTruthy()
  })

  it('offers no fork for Codex, nothing read-only or where it cannot resume', async () => {
    const live = { tabId: 't', paneId: 'p' }
    lists.push(listOf([session('x', { agent: 'codex', live })]))
    const first = setup()
    fireEvent.click(await screen.findByText('Title x'))
    expect(
      screen.getByRole('button', { name: 'Open the running tab' }),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
    expect(screen.queryByText(/A fork is/)).toBeNull()
    first.unmount()

    lists.push(listOf([session('a')]))
    const ro = setup({}, { readOnly: true })
    fireEvent.click(await screen.findByText('Title a'))
    expect(
      screen.getByText('View only: sessions can be read, not resumed.'),
    ).toBeTruthy()
    ro.unmount()

    lists.push(listOf([session('a')]))
    setup({}, { canResume: false })
    fireEvent.click(await screen.findByText('Title a'))
    expect(screen.queryByRole('button', { name: /Resume/ })).toBeNull()
  })

  it('opens at a session, and its links through the pane', async () => {
    const open = session('a', { title: 'Old title' })
    lists.push(listOf([session('a', { title: 'New title' })]))
    const openFile = vi.fn(async () => {})
    setup({ open }, { openFile })
    expect(screen.getByText('transcript of a')).toBeTruthy()
    await screen.findByText('New title')
    fireEvent.click(screen.getByRole('button', { name: 'open file' }))
    expect(openFile).toHaveBeenCalledWith('p1', 'a.ts', 3)
    // Back (the browser's) goes to the list
    await act(async () => {
      window.history.back()
      await new Promise((r) => setTimeout(r, 20))
    })
    await screen.findByRole('searchbox')
  })

  it('opens no links without a way to the files', async () => {
    lists.push(listOf([session('a')]))
    setup({ open: session('a') })
    expect(screen.queryByRole('button', { name: 'open file' })).toBeNull()
  })
})
