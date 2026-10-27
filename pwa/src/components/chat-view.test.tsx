import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { ThemeProvider } from '../contexts/theme-context'
import type { TranscriptState } from '../hooks/use-agent-transcript'
import { resetChatAttachments } from '../hooks/use-chat-attachments'
import type { AgentPrompt, TranscriptEntry } from '../hooks/use-mux-api'
import { paneSelection, resetPaneSelections } from '../utils/pane-selection'
import ChatView, { chatLayout, RENDER_WINDOW } from './chat-view'
import { OpenTerminalButton } from './open-terminal-button'

const transcript = {
  state: { entries: [], loaded: true, loadingOlder: false } as TranscriptState,
  refresh: vi.fn(),
  loadOlder: vi.fn(),
}
const promptStore = {
  prompt: null as AgentPrompt | null,
  pane: undefined as unknown,
}
vi.mock('../hooks/use-agent-prompt', () => ({
  useAgentPrompt: (pane: unknown) => {
    promptStore.pane = pane
    return {
      prompt: promptStore.prompt,
      loaded: true,
      refresh: vi.fn(),
      show: vi.fn(),
    }
  },
}))
vi.mock('../hooks/use-agent-transcript', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-agent-transcript')>()),
  useAgentTranscript: () => ({
    ...transcript.state,
    refresh: transcript.refresh,
    loadOlder: transcript.loadOlder,
  }),
}))

const mockFollowPath = vi.fn()
vi.mock('../hooks/use-files', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-files')>()),
  followPathInFiles: (...a: unknown[]) => mockFollowPath(...a),
}))

vi.mock('../utils/highlight', async (orig) => ({
  ...(await orig<typeof import('../utils/highlight')>()),
  highlightLang: () => Promise.resolve(null),
}))

const entry = (i: number): TranscriptEntry => ({
  id: `e${i}`,
  role: i % 2 ? 'assistant' : 'user',
  parts: [{ kind: 'text', text: `message ${i}` }],
})
const entries = (n: number) => Array.from({ length: n }, (_, i) => entry(i))

const showView = vi.fn()
const props: ViewProps = {
  mux: {
    backend: 'tmux',
    caps: { clientSideSelect: false, copyMode: true, agentChat: true },
  },
  session: {
    id: '0',
    name: 'claude',
    icon: '',
    description: '',
    paneId: '0',
    hasAgent: true,
    agentName: 'claude',
  },
  readOnly: false,
  isMobile: false,
  notify: vi.fn(),
  showView,
}

const set = (s: Partial<TranscriptState>) => {
  transcript.state = { entries: [], loaded: true, loadingOlder: false, ...s }
}

// jsdom has no layout: give the list a size and a scroll position.
function layout(
  el: HTMLElement,
  { scrollHeight = 1000, clientHeight = 200, scrollTop = 800 } = {},
) {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    value: scrollHeight,
  })
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    value: clientHeight,
  })
  el.scrollTop = scrollTop
}

beforeEach(() => {
  resetChatAttachments()
  vi.clearAllMocks()
  set({})
  promptStore.prompt = null
})

describe('ChatView', () => {
  it('says it is loading until the first read', () => {
    set({ loaded: false })
    render(<ChatView {...props} />)
    expect(screen.getByText('Loading the conversation…')).toBeInTheDocument()
  })

  it('without a session, explains and offers the terminal', () => {
    set({ error: 'no-session' })
    render(<ChatView {...props} />)
    expect(
      screen.getByText('No Claude Code session found in this pane.'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(showView).toHaveBeenCalledWith('terminal')
  })

  it('a failed first read says so', () => {
    set({ error: 'unavailable' })
    render(<ChatView {...props} />)
    expect(
      screen.getByText('Could not read the conversation.'),
    ).toBeInTheDocument()
  })

  it('names the pane, lists the messages, and flags a failing poll', () => {
    set({ entries: entries(3), error: 'unavailable' })
    render(<ChatView {...props} />)
    expect(screen.getByText('Claude Code · claude')).toBeInTheDocument()
    expect(screen.getByText('message 2')).toBeInTheDocument()
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument()
  })

  it('keeps text selected in the conversation for a template', () => {
    resetPaneSelections()
    set({ entries: entries(1) })
    render(<ChatView {...props} />)
    const range = document.createRange()
    range.selectNodeContents(screen.getByText('message 0'))
    const sel = document.getSelection() as Selection
    sel.removeAllRanges()
    sel.addRange(range)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(paneSelection('0')).toEqual({
      text: 'message 0',
      source: 'the Chat',
    })
    sel.removeAllRanges()
  })

  it('shows the hidden characters of the session name', () => {
    set({ entries: entries(1) })
    render(
      <ChatView
        {...props}
        session={{ ...props.session!, name: 'cla\u202eude' }}
      />,
    )
    expect(screen.getByText('Claude Code · cla⟨U+202E⟩ude')).toBeInTheDocument()
  })

  it('an empty conversation says so', () => {
    render(<ChatView {...props} />)
    expect(screen.getByText('No messages yet.')).toBeInTheDocument()
  })

  it('renders the last window and shows more on request, then asks for older entries', () => {
    set({ entries: entries(RENDER_WINDOW + 10), before: 'b' })
    render(<ChatView {...props} />)
    expect(screen.queryByText('message 9')).toBeNull()
    expect(screen.getByText('message 10')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    expect(screen.getByText('message 0')).toBeInTheDocument()
    expect(transcript.loadOlder).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    expect(transcript.loadOlder).toHaveBeenCalled()
  })

  it('reaching the top loads older entries; the button waits while loading', () => {
    set({ entries: entries(2), before: 'b', loadingOlder: true })
    render(<ChatView {...props} />)
    expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled()
    const list = screen.getByRole('region', { name: 'Conversation' })
    layout(list, { scrollTop: 0 })
    fireEvent.scroll(list)
    expect(transcript.loadOlder).toHaveBeenCalled()
  })

  it('follows new messages at the bottom, and offers a jump when reading above', () => {
    set({ entries: entries(2) })
    const { rerender } = render(<ChatView {...props} />)
    const list = screen.getByRole('region', { name: 'Conversation' })
    layout(list, { scrollTop: 800 })
    // At the bottom: a new entry scrolls into view
    set({ entries: entries(3) })
    rerender(<ChatView {...props} />)
    expect(list.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull()
    // Scrolled up: a new entry offers the jump instead
    layout(list, { scrollTop: 100 })
    fireEvent.scroll(list)
    set({ entries: entries(4) })
    rerender(<ChatView {...props} />)
    expect(list.scrollTop).toBe(100)
    fireEvent.click(screen.getByRole('button', { name: 'New messages' }))
    expect(list.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull()
  })

  it('scrolling back to the bottom clears the jump', () => {
    set({ entries: entries(2) })
    const { rerender } = render(<ChatView {...props} />)
    const list = screen.getByRole('region', { name: 'Conversation' })
    layout(list, { scrollTop: 100 })
    fireEvent.scroll(list)
    set({ entries: entries(3) })
    rerender(<ChatView {...props} />)
    expect(
      screen.getByRole('button', { name: 'New messages' }),
    ).toBeInTheDocument()
    layout(list, { scrollTop: 790 })
    act(() => {
      fireEvent.scroll(list)
    })
    expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull()
  })

  it('another session starts again at its end', () => {
    set({ entries: entries(RENDER_WINDOW + 5), sessionId: 's1' })
    const { rerender } = render(<ChatView {...props} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    expect(screen.getByText('message 0')).toBeInTheDocument()
    set({ entries: entries(RENDER_WINDOW + 5), sessionId: 's2' })
    rerender(<ChatView {...props} />)
    expect(screen.queryByText('message 0')).toBeNull()
  })
})

describe('ChatView file paths', () => {
  const withFiles: ViewProps = {
    ...props,
    mux: { ...props.mux, caps: { ...props.mux.caps, files: true } },
  }
  const say = (text: string): TranscriptEntry => ({
    id: 'a',
    role: 'assistant',
    parts: [{ kind: 'text', text }],
  })
  const tool = (name: string, input: string): TranscriptEntry => ({
    id: 't',
    role: 'assistant',
    parts: [{ kind: 'tool', tool: name, toolId: '1', input, result: 'ok' }],
  })

  it('opens inline code that names a file in Files, at its line', async () => {
    mockFollowPath.mockResolvedValue('opened')
    set({ entries: [say('See `pwa/src/a.ts:12` and `window.location`.')] })
    render(<ChatView {...withFiles} />)
    const link = screen.getByRole('button', {
      name: 'pwa/src/a.ts:12',
    })
    expect(link).toHaveAttribute('title', 'Open pwa/src/a.ts:12 in Files')
    await act(async () => fireEvent.click(link))
    expect(mockFollowPath).toHaveBeenCalledWith('0', 'pwa/src/a.ts', 12)
    expect(showView).toHaveBeenCalledWith('files')
    expect(
      screen.queryByRole('button', { name: 'window.location' }),
    ).not.toBeInTheDocument()
  })

  it('opens a relative Markdown link; an http one stays a link', async () => {
    mockFollowPath.mockResolvedValue('opened')
    set({
      entries: [
        say('[the guide](docs/guide.md#L4) and [`a/b.ts`](https://x.test/a)'),
      ],
    })
    render(<ChatView {...withFiles} />)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'the guide' })),
    )
    expect(mockFollowPath).toHaveBeenCalledWith('0', 'docs/guide.md', 4)
    // Inline code inside a link is not a second link
    expect(screen.getByRole('link', { name: 'a/b.ts' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'a/b.ts' }),
    ).not.toBeInTheDocument()
  })

  it.each([
    ['Read', '/r/p/src/a.ts', '/r/p/src/a.ts', '/r/p/src/a.ts'],
    ['Write', '/r/p/src/b.ts', 'b.ts', '/r/p/src/b.ts'],
    ['Edit', 'src/old.ts → src/new.ts', 'new.ts', 'src/new.ts'],
    ['MultiEdit', 'src/c.ts', 'c.ts', 'src/c.ts'],
    ['ViewImage', '/r/p/shot.png', '/r/p/shot.png', '/r/p/shot.png'],
  ])('opens the file of a %s card', async (name, input, label, path) => {
    mockFollowPath.mockResolvedValue('opened')
    set({ entries: [tool(name, input)] })
    render(<ChatView {...withFiles} />)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: label })),
    )
    expect(mockFollowPath).toHaveBeenCalledWith('0', path, undefined)
  })

  it('a path the server shortened is not a link', () => {
    const cut = `src/${'a'.repeat(190)}…`
    set({ entries: [tool('Edit', cut)] })
    render(<ChatView {...withFiles} />)
    const name = screen.getByTitle(cut)
    expect(name.tagName).toBe('SPAN')
    expect(name).toHaveClass('text-accent')
  })

  it('a code block and a tool without a file are no links', () => {
    set({ entries: [say('```\nsrc/a.ts\n```'), tool('Grep', 'src/a.ts')] })
    render(
      <ThemeProvider>
        <ChatView {...withFiles} />
      </ThemeProvider>,
    )
    expect(
      screen.queryByRole('button', { name: /src\/a\.ts/ }),
    ).not.toBeInTheDocument()
  })

  it('an image inside a file link is its label, not a link', () => {
    set({ entries: [say('[![shot](https://h.test/a.png)](docs/a.md)')] })
    render(<ChatView {...withFiles} />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '[image: h.test]' }),
    ).toBeInTheDocument()
  })

  it.each([
    ['missing', 'Not found'],
    ['failed', "This link can't be opened"],
    ['outside', "This file is outside the pane's folder"],
  ])('%s: says so and stays', async (result, notice) => {
    mockFollowPath.mockResolvedValue(result)
    set({ entries: [say('`src/a.ts`')] })
    render(<ChatView {...withFiles} />)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' })),
    )
    expect(props.notify).toHaveBeenCalledWith(notice)
    expect(showView).not.toHaveBeenCalled()
  })

  it('without a Files view, paths are plain text', () => {
    set({ entries: [say('`src/a.ts` [g](docs/g.md)'), tool('Read', 'a/b.ts')] })
    render(<ChatView {...props} />)
    expect(screen.queryAllByRole('button', { name: /a\.ts|g|b\.ts/ })).toEqual(
      [],
    )
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('a/b.ts')).toHaveAttribute('title', 'a/b.ts')
  })
})

describe('ChatView runs of steps', () => {
  const bash = (id: string, result?: string): TranscriptEntry => ({
    id,
    role: 'assistant',
    parts: [
      {
        kind: 'tool',
        tool: 'Bash',
        toolId: id,
        result,
        detail: { command: id },
      },
    ],
  })

  it('folds three steps in a row into one line, which opens', () => {
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2', 'r2'), bash('c3', 'r3')],
      status: 'idle',
    })
    render(<ChatView {...props} />)
    expect(screen.getByText('3 commands')).toBeInTheDocument()
    expect(screen.queryByText('c1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /3 commands/ }))
    expect(screen.getByText('c1')).toBeInTheDocument()
  })

  it('a live run keeps what the reader opened as it becomes a run', () => {
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2')],
      status: 'working',
    })
    const { rerender } = render(<ChatView {...props} />)
    fireEvent.click(screen.getByText('Output · 1 line'))
    expect(screen.getByText('r1')).toBeInTheDocument()
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2', 'r2'), bash('c3')],
      status: 'working',
    })
    rerender(<ChatView {...props} />)
    expect(screen.getByRole('button', { name: '3 commands' })).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    expect(screen.getByText('r1')).toBeInTheDocument()
    // Done, it stays open until folded
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2', 'r2'), bash('c3', 'r3')],
      status: 'idle',
    })
    rerender(<ChatView {...props} />)
    expect(screen.getByText('c3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '3 commands' }))
    expect(screen.queryByText('c3')).toBeNull()
  })

  it('a call left without a result keeps nothing open once the agent is idle', () => {
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2', 'r2'), bash('c3')],
      status: 'idle',
    })
    render(<ChatView {...props} />)
    expect(screen.queryByText('c3')).toBeNull()
  })

  it('read above, a live run longer than the window keeps its tail as the window moves', () => {
    const steps = (n: number) =>
      Array.from({ length: n }, (_, i) => bash(`cmd${i}`, 'r'))
    set({
      entries: [entry(0), ...steps(RENDER_WINDOW + 10)],
      status: 'working',
    })
    const { rerender } = render(<ChatView {...props} />)
    const last = RENDER_WINDOW + 9
    expect(screen.getByText(`cmd${last - 5}`)).toBeInTheDocument()
    expect(screen.queryByText(`cmd${last - 6}`)).toBeNull()
    const list = screen.getByRole('region', { name: 'Conversation' })
    layout(list, { scrollTop: 100 })
    fireEvent.scroll(list)
    // Each new step moves the window down one entry
    set({
      entries: [entry(0), ...steps(RENDER_WINDOW + 12)],
      status: 'working',
    })
    rerender(<ChatView {...props} />)
    expect(screen.getByText(`cmd${last - 5}`)).toBeInTheDocument()
    expect(screen.getByText(`cmd${last + 2}`)).toBeInTheDocument()
  })

  it('a run the window hides whole is not drawn', () => {
    set({
      entries: [
        bash('c1', 'r'),
        bash('c2', 'r'),
        bash('c3', 'r'),
        ...entries(RENDER_WINDOW),
      ],
      status: 'idle',
    })
    render(<ChatView {...props} />)
    expect(screen.queryByText('3 commands')).toBeNull()
  })

  it('without a status, a call waiting for its result keeps the last run open', () => {
    set({ entries: [entry(0), bash('c1', 'r'), bash('c2', 'r'), bash('c3')] })
    render(<ChatView {...props} />)
    expect(screen.getByText('c1')).toBeInTheDocument()
  })

  it('a run cut by the window down to its thinking shows that as it is', () => {
    const think: TranscriptEntry = {
      id: 'th',
      role: 'assistant',
      parts: [{ kind: 'thinking', text: 'hm' }],
    }
    set({
      entries: [
        bash('c1', 'r'),
        bash('c2', 'r'),
        think,
        ...entries(RENDER_WINDOW - 1),
      ],
      status: 'idle',
    })
    render(<ChatView {...props} />)
    expect(screen.getByText('Thinking')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    expect(screen.getByText('2 commands')).toBeInTheDocument()
  })

  it('a run cut by the window shows its part, and grows as more is shown', () => {
    set({
      entries: [
        bash('c1', 'r'),
        bash('c2', 'r'),
        bash('c3', 'r'),
        bash('c4', 'r'),
        ...entries(RENDER_WINDOW - 3),
      ],
      status: 'idle',
    })
    render(<ChatView {...props} />)
    expect(screen.getByText('3 commands')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    expect(screen.getByText('4 commands')).toBeInTheDocument()
  })
})

describe('ChatView agent state', () => {
  it('the header shows the agent status', () => {
    set({ entries: entries(1), status: 'blocked' })
    render(<ChatView {...props} />)
    expect(
      screen.getByRole('img', { name: 'Agent blocked' }),
    ).toBeInTheDocument()
  })

  it('only view-only reads the dialog here, and shows it without buttons', () => {
    const dialog: AgentPrompt = {
      promptId: 'id1',
      kind: 'permission',
      title: 'Bash command',
      options: [{ index: 1, label: 'Yes' }],
    }
    promptStore.prompt = dialog
    set({ entries: entries(1) })
    const { rerender } = render(<ChatView {...props} />)
    // The composer shows the card; the view does not poll the dialog
    expect(promptStore.pane).toBeUndefined()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    rerender(<ChatView {...props} readOnly />)
    expect(promptStore.pane).toBe('0')
    expect(
      screen.getByRole('region', { name: 'Bash command' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Yes/ })).toBeNull()
  })

  it('view-only does not read the dialog of an agent without input', () => {
    set({ entries: entries(1) })
    render(
      <ChatView
        {...props}
        readOnly
        session={{ ...props.session, name: 'pi', agentName: 'pi' }}
      />,
    )
    expect(promptStore.pane).toBeUndefined()
    expect(screen.getByText('agent · pi')).toBeInTheDocument()
  })

  it('view-only reads the dialog of a Codex pane', () => {
    set({ entries: entries(1) })
    render(
      <ChatView
        {...props}
        readOnly
        session={{ ...props.session, name: 'codex', agentName: 'codex' }}
      />,
    )
    expect(promptStore.pane).toBe('0')
    expect(screen.getByText('Codex · codex')).toBeInTheDocument()
  })

  it('names an agent it has no label for generically', () => {
    set({ error: 'no-session' })
    render(
      <ChatView {...props} session={{ ...props.session, agentName: 'pi' }} />,
    )
    expect(
      screen.getByText('No agent session found in this pane.'),
    ).toBeInTheDocument()
  })

  it('view-only on a pane-less session passes an empty pane id', () => {
    promptStore.prompt = { kind: 'unsupported', title: 'x' }
    set({ entries: entries(1) })
    render(
      <ChatView
        {...props}
        readOnly
        session={{ ...props.session, paneId: undefined }}
      />,
    )
    expect(screen.getByRole('region', { name: 'x' })).toBeInTheDocument()
  })
})

describe('ChatView older entries', () => {
  it('keeps the entry being read in place when older ones arrive', () => {
    set({ entries: entries(2), before: 'b' })
    const { rerender } = render(<ChatView {...props} />)
    const list = screen.getByRole('region', { name: 'Conversation' })
    layout(list, { scrollHeight: 1000, scrollTop: 0 })
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    expect(transcript.loadOlder).toHaveBeenCalledTimes(1)
    // A second request while waiting does nothing
    fireEvent.scroll(list)
    expect(transcript.loadOlder).toHaveBeenCalledTimes(1)
    set({ entries: entries(2), before: 'b', loadingOlder: true })
    rerender(<ChatView {...props} />)
    // Two older entries come in front, all of them shown
    const older: TranscriptEntry[] = [
      { id: 'o1', role: 'user', parts: [{ kind: 'text', text: 'older 1' }] },
      { id: 'o2', role: 'user', parts: [{ kind: 'text', text: 'older 2' }] },
    ]
    Object.defineProperty(list, 'scrollHeight', {
      configurable: true,
      value: 1400,
    })
    set({ entries: [...older, ...entries(2)] })
    rerender(<ChatView {...props} />)
    expect(screen.getByText('older 1')).toBeInTheDocument()
    expect(list.scrollTop).toBe(400)
  })

  it('nothing coming back lets the next request through', () => {
    set({ entries: entries(2), before: 'b' })
    const { rerender } = render(<ChatView {...props} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    set({ entries: entries(2), before: 'b', loadingOlder: true })
    rerender(<ChatView {...props} />)
    set({ entries: entries(2), before: 'b' })
    rerender(<ChatView {...props} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    expect(transcript.loadOlder).toHaveBeenCalledTimes(2)
  })

  it('at the top with nothing older, scrolling asks for nothing', () => {
    set({ entries: entries(2) })
    render(<ChatView {...props} />)
    const list = screen.getByRole('region', { name: 'Conversation' })
    layout(list, { scrollTop: 0 })
    fireEvent.scroll(list)
    expect(transcript.loadOlder).not.toHaveBeenCalled()
  })

  it('shows the hidden characters of the pane label', () => {
    set({ entries: entries(1) })
    render(
      <ChatView
        {...props}
        session={{
          ...props.session,
          paneId: 'p2',
          panes: [
            { id: 'p1', label: 'claude', hasAgent: true },
            { id: 'p2', label: 'rev\u202eiewer', hasAgent: true },
          ],
        }}
      />,
    )
    expect(
      screen.getByText('Claude Code · claude · rev⟨U+202E⟩iewer'),
    ).toBeInTheDocument()
  })

  it('a split tab names the pane in the header', () => {
    set({ entries: entries(1) })
    render(
      <ChatView
        {...props}
        session={{
          ...props.session,
          paneId: 'p2',
          panes: [
            { id: 'p1', label: 'claude', hasAgent: true },
            { id: 'p2', label: 'reviewer', hasAgent: true },
          ],
        }}
      />,
    )
    expect(
      screen.getByText('Claude Code · claude · reviewer'),
    ).toBeInTheDocument()
  })
})

describe('ChatView resizing', () => {
  it('a list that shrinks while at the bottom stays at the bottom', () => {
    let fire: (() => void) | undefined
    const disconnect = vi.fn()
    const observe = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb
        }
        observe = observe
        disconnect = disconnect
      },
    )
    set({ entries: entries(3) })
    const { unmount } = render(<ChatView {...props} />)
    const list = screen.getByRole('region', { name: 'Conversation' })
    // The box, and its content: a diagram drawn late makes it taller
    expect(observe).toHaveBeenCalledWith(list)
    expect(observe).toHaveBeenCalledWith(list.firstElementChild)
    layout(list, { scrollTop: 800 })
    fireEvent.scroll(list)
    layout(list, { scrollHeight: 1100, scrollTop: 800 })
    act(() => fire!())
    expect(list.scrollTop).toBe(1100)
    // Reading above: a resize leaves the position alone
    layout(list, { scrollTop: 100 })
    fireEvent.scroll(list)
    act(() => fire!())
    expect(list.scrollTop).toBe(100)
    unmount()
    expect(disconnect).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('ChatView reading above', () => {
  it('content growing above the entry being read keeps it in place', () => {
    let fire: (() => void) | undefined
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb
        }
        observe() {}
        disconnect() {}
      },
    )
    set({ entries: entries(3) })
    render(<ChatView {...props} />)
    const list = screen.getByRole('region', { name: 'Conversation' })
    const [first, second] = (list.firstElementChild as Element).children
    // Where each sits in the window: the list from 0, the first entry above it
    const tops = new Map<Element, number>([
      [list, 0],
      [first, -100],
      [second, 20],
    ])
    for (const el of [list, first, second]) {
      el.getBoundingClientRect = () =>
        ({ top: tops.get(el), height: 50 }) as DOMRect
    }
    layout(list, { scrollTop: 100 })
    fireEvent.scroll(list)
    // A diagram above it is drawn: the entry moves down by 40
    tops.set(second, 60)
    act(() => fire!())
    expect(list.scrollTop).toBe(140)
    // Nothing on screen to hold: the position is left alone
    tops.set(first, -300)
    tops.set(second, -200)
    fireEvent.scroll(list)
    act(() => fire!())
    expect(list.scrollTop).toBe(140)
    vi.unstubAllGlobals()
  })
})

describe('ChatView diagrams', () => {
  it('a diagram waits to come near the conversation, not the page', () => {
    let root: Element | null | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(_cb: unknown, opts: IntersectionObserverInit) {
          root = opts.root as Element | null
        }
        observe() {}
        disconnect() {}
      },
    )
    set({
      entries: [
        {
          id: 'm',
          role: 'assistant',
          parts: [
            { kind: 'text', text: '```mermaid\nflowchart LR\n  A --> B\n```' },
          ],
        },
      ],
    })
    render(
      <ThemeProvider>
        <ChatView {...props} />
      </ThemeProvider>,
    )
    expect(root).toBe(screen.getByRole('region', { name: 'Conversation' }))
    expect(screen.getByText('Rendering diagram…')).toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})

describe('OpenTerminalButton', () => {
  it('switches to the terminal view', () => {
    render(<OpenTerminalButton showView={showView} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(showView).toHaveBeenCalledWith('terminal')
  })
})

describe('ChatView without an agent', () => {
  const start = vi.fn()
  const idle: ViewProps = {
    ...props,
    mux: {
      backend: 'herdr',
      caps: {
        clientSideSelect: true,
        copyMode: false,
        agentChat: true,
        agentStart: true,
        agentStartCodex: true,
      },
    },
    session: {
      id: 'w1:t1',
      name: 'tab',
      icon: '',
      description: '',
      paneId: 'w1:p1',
      hasAgent: false,
      panes: [
        { id: 'w1:p1', label: 'Pane 1', hasAgent: false, command: 'bash' },
      ],
    },
    agentStart: { starts: {}, start },
  }
  const withStart = (
    kind: 'claude' | 'codex',
    phase: 'sending' | 'starting' | 'ready' | 'failed',
    error?: string,
  ): ViewProps => ({
    ...idle,
    agentStart: {
      starts: { 'w1:p1': { kind, phase, error, since: 0 } },
      start,
    },
  })

  it('offers both agents on an idle pane and starts the one picked', () => {
    render(<ChatView {...idle} />)
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    expect(start).toHaveBeenCalledWith('w1:p1', 'codex')
    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeTruthy()
  })

  it('offers only Claude Code when the server cannot start Codex', () => {
    const mux = {
      ...idle.mux,
      caps: { ...idle.mux.caps, agentStartCodex: false },
    }
    render(<ChatView {...idle} mux={mux} />)
    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Codex' })).toBeNull()
  })

  it('follows a start while the pane runs the agent but the snapshot has none yet', () => {
    render(
      <ChatView
        {...withStart('claude', 'starting')}
        session={{
          ...idle.session,
          panes: [
            { id: 'w1:p1', label: '', hasAgent: false, command: 'claude' },
          ],
        }}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain(
      'Starting Claude Code…',
    )
  })

  it('tells Codex users to type the first message in the terminal', () => {
    render(<ChatView {...withStart('codex', 'ready')} />)
    expect(
      screen.getByText(/Type your first message in the terminal/),
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(showView).toHaveBeenCalledWith('terminal')
  })

  it('says Claude Code is starting until its session shows', () => {
    const p = withStart('claude', 'ready')
    const { rerender } = render(<ChatView {...p} />)
    expect(screen.getByText('Claude Code is starting…')).toBeTruthy()
    // The snapshot has the agent, Herdr not its session yet
    set({ error: 'no-session' })
    rerender(
      <ChatView
        {...p}
        session={{ ...p.session, hasAgent: true, agentName: 'claude' }}
      />,
    )
    expect(screen.getByText('Claude Code is starting…')).toBeTruthy()
  })

  it('shows why a start was refused', () => {
    render(
      <ChatView {...withStart('claude', 'failed', 'This pane is gone.')} />,
    )
    expect(screen.getByRole('alert').textContent).toBe('This pane is gone.')
  })

  it('offers nothing on a tab with no pane yet', () => {
    render(
      <ChatView {...idle} session={{ ...idle.session, paneId: undefined }} />,
    )
    expect(screen.getByText('No agent runs in this pane.')).toBeTruthy()
  })

  it('reads a tab with no pane as one without a start', () => {
    set({ error: 'no-session' })
    render(
      <ChatView
        {...withStart('claude', 'ready')}
        session={{
          ...idle.session,
          paneId: undefined,
          hasAgent: true,
          agentName: 'claude',
        }}
      />,
    )
    expect(
      screen.getByText('No Claude Code session found in this pane.'),
    ).toBeTruthy()
  })

  it('offers nothing on a pane running something else', () => {
    render(
      <ChatView
        {...idle}
        session={{
          ...idle.session,
          panes: [{ id: 'w1:p1', label: '', hasAgent: false, command: 'vim' }],
        }}
      />,
    )
    expect(screen.getByText('No agent runs in this pane.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Codex' })).toBeNull()
  })
})

describe('chatLayout', () => {
  const e = (
    id: string,
    role: TranscriptEntry['role'],
    ts?: string,
    tool = false,
  ): TranscriptEntry => ({
    id,
    role,
    ts,
    parts: [tool ? { kind: 'tool', orphan: true } : { kind: 'text', text: id }],
  })
  it('times the start of each run and joins the agent steps', () => {
    const layout = chatLayout([
      e('u1', 'user', '2026-10-08T09:00:00Z'),
      e('a1', 'assistant', '2026-10-08T09:00:10Z'),
      e('r1', 'user', '2026-10-08T09:00:20Z', true),
      e('a2', 'assistant', '2026-10-08T09:10:00Z'),
      e('n1', 'note'),
      e('u2', 'user', '2026-10-08T09:11:00Z'),
      e('u3', 'user', '2026-10-08T09:12:00Z'),
    ])
    expect(layout.map((l) => l.showTime)).toEqual([
      true,
      true,
      false,
      true,
      false,
      true,
      false,
    ])
    expect(layout.map((l) => l.joinsNext)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ])
  })
})
