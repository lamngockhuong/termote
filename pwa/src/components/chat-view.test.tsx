import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { ThemeProvider } from '../contexts/theme-context'
import type { TranscriptState } from '../hooks/use-agent-transcript'
import { resetChatAttachments } from '../hooks/use-chat-attachments'
import type {
  AgentActivity,
  AgentPrompt,
  Subagents,
  TranscriptEntry,
} from '../hooks/use-mux-api'
import type { MessageKey } from '../i18n/messages/en'
import {
  chatSelection,
  hasChatSelection,
  resetChatSelections,
  setChatSelection,
} from '../utils/chat-selection'
import { paneSelection, resetPaneSelections } from '../utils/pane-selection'
import { FILES_VIEW_ID } from '../view-ids'
import { chatLayout } from './chat-transcript-list'
import ChatView, { RENDER_WINDOW, resetChatPlaces } from './chat-view'
import { OpenTerminalButton } from './open-terminal-button'

const transcript = {
  state: { entries: [], loaded: true, loadingOlder: false } as TranscriptState,
  refresh: vi.fn(),
  loadOlder: vi.fn(),
}
const promptStore = {
  prompt: null as AgentPrompt | null,
  activity: null as AgentActivity | null,
  pane: undefined as unknown,
  livePane: undefined as unknown,
}
vi.mock('../hooks/use-agent-prompt', () => ({
  useAgentActivity: (pane: unknown) => {
    promptStore.livePane = pane
    return { activity: promptStore.activity, dialog: !!promptStore.prompt }
  },
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
// The questions themselves are ChatAsks' own test: here a stand-in that
// names the pane whose questions it shows
vi.mock('./chat-asks', () => ({
  ChatAsks: ({
    paneId,
    clockOffset,
    hiddenGroupIds,
  }: {
    paneId: string
    clockOffset: number
    hiddenGroupIds?: ReadonlySet<string>
  }) => (
    <p data-testid="chat-asks">
      {`${paneId} ${clockOffset} ${[...(hiddenGroupIds ?? [])].join(',')}`}
    </p>
  ),
}))
vi.mock('../hooks/use-agent-transcript', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-agent-transcript')>()),
  useAgentTranscript: () => ({
    ...transcript.state,
    refresh: transcript.refresh,
    loadOlder: transcript.loadOlder,
  }),
}))

const subagents = {
  tree: undefined as Subagents | undefined,
  panes: [] as string[],
}
vi.mock('../hooks/use-subagents', () => ({
  // The panes whose tree is read (a closed reader reads none)
  useSubagents: (pane: string, open: boolean) => {
    if (open) subagents.panes.push(pane)
    return { tree: subagents.tree, error: false }
  },
}))

// The sheet itself is SubagentTranscriptSheet's own test: here a stand-in
// that names what it shows and closes.
vi.mock('./subagent-transcript-sheet', () => ({
  SubagentTranscriptSheet: (p: {
    target?: { paneId: string; node: { id: string } }
    onClose: () => void
  }) =>
    p.target ? (
      <div role="dialog" aria-label="subagent sheet">
        {p.target.paneId}/{p.target.node.id}
        <button type="button" onClick={p.onClose}>
          close sheet
        </button>
      </div>
    ) : null,
}))

const mockFollowPath = vi.fn()
const mockOpenOutside = vi.fn()
vi.mock('../hooks/use-files', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-files')>()),
  followPathInFiles: (...a: unknown[]) => mockFollowPath(...a),
  openOutsideInFiles: (...a: unknown[]) => mockOpenOutside(...a),
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
  resetChatPlaces()
  vi.clearAllMocks()
  set({})
  promptStore.prompt = null
  promptStore.activity = null
  subagents.tree = undefined
  subagents.panes = []
})

describe('ChatView', () => {
  it("shows the questions its pane's orchestrator asked, on a full client only", () => {
    set({ entries: [entry(0)] })
    const { rerender } = render(<ChatView {...props} clockOffset={1500} />)
    expect(screen.getByTestId('chat-asks')).toHaveTextContent('0 1500')
    rerender(<ChatView {...props} hiddenGroupIds={new Set(['w2'])} />)
    expect(screen.getByTestId('chat-asks')).toHaveTextContent('0 0 w2')
    rerender(<ChatView {...props} readOnly />)
    expect(screen.queryByTestId('chat-asks')).toBeNull()
  })

  it('fades in only a message that came after the conversation showed', () => {
    const root = (text: string) =>
      screen.getByText(text).closest('[data-role]') as HTMLElement
    const enters = 'motion-safe:starting:opacity-0'
    set({ entries: [entry(2), entry(3)] })
    const { rerender } = render(<ChatView {...props} />)
    expect(root('message 2')).not.toHaveClass(enters)
    set({ entries: [entry(2), entry(3), entry(4)] })
    rerender(<ChatView {...props} />)
    expect(root('message 4')).toHaveClass(enters)
    expect(root('message 3')).not.toHaveClass(enters)
    // Older messages loaded above are history, not news
    set({ entries: [entry(0), entry(1), entry(2), entry(3), entry(4)] })
    rerender(<ChatView {...props} />)
    expect(root('message 0')).not.toHaveClass(enters)
    expect(root('message 4')).toHaveClass(enters)
    // Another pane's conversation starts afresh
    set({ entries: [entry(5)] })
    rerender(
      <ChatView {...props} session={{ ...props.session, paneId: '1' }} />,
    )
    expect(root('message 5')).not.toHaveClass(enters)
  })

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

  it('names the agent, lists the messages, and flags a failing poll', () => {
    set({ entries: entries(3), error: 'unavailable' })
    render(<ChatView {...props} />)
    // The session's tab names the session on a desktop
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('message 2')).toBeInTheDocument()
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument()
    // The messages keep the browser's menu, the header does not
    expect(
      screen.getByText('message 2').closest('[data-native-menu]'),
    ).not.toBeNull()
    expect(
      screen.getByText('Claude Code').closest('[data-native-menu]'),
    ).toBeNull()
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
      source: 'chat.fill.from.chat',
    })
    sel.removeAllRanges()
  })

  it('keeps the text selected for a quote until touched again or left', () => {
    resetChatSelections()
    set({ entries: entries(2) })
    const { rerender, unmount } = render(<ChatView {...props} />)
    const pick = (text: string) => {
      const range = document.createRange()
      range.selectNodeContents(screen.getByText(text))
      const sel = document.getSelection() as Selection
      sel.removeAllRanges()
      sel.addRange(range)
      act(() => {
        document.dispatchEvent(new Event('selectionchange'))
      })
    }
    pick('message 1')
    expect(chatSelection('0')).toBe('message 1')
    // The DOM selection gone, a message in: still kept
    document.getSelection()?.removeAllRanges()
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
    set({ entries: entries(3) })
    rerender(<ChatView {...props} />)
    expect(chatSelection('0')).toBe('message 1')
    // A click that keeps the text selected (on it) keeps it; one that
    // leaves nothing selected forgets it
    const region = screen.getByRole('region', { name: 'Conversation' })
    pick('message 1')
    fireEvent.click(region)
    expect(chatSelection('0')).toBe('message 1')
    document.getSelection()?.removeAllRanges()
    fireEvent.click(region)
    expect(hasChatSelection('0')).toBe(false)
    // Another pane: the one left forgets its selection, the new one keeps its own
    pick('message 2')
    rerender(
      <ChatView {...props} session={{ ...props.session, paneId: '1' }} />,
    )
    expect(hasChatSelection('0')).toBe(false)
    pick('message 2')
    expect(chatSelection('1')).toBe('message 2')
    // The view closed
    unmount()
    expect(hasChatSelection('1')).toBe(false)
    document.getSelection()?.removeAllRanges()
  })

  it('a pane without an id keeps no quote', () => {
    resetChatSelections()
    set({ entries: entries(1) })
    render(
      <ChatView {...props} session={{ ...props.session, paneId: undefined }} />,
    )
    setChatSelection('', 'x')
    document.getSelection()?.removeAllRanges()
    fireEvent.click(screen.getByRole('region', { name: 'Conversation' }))
    expect(chatSelection('')).toBe('x')
  })

  it('names the session on a phone, with its hidden characters', () => {
    set({ entries: entries(1) })
    render(
      <ChatView
        {...props}
        isMobile
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

  it('another tab and back finds the place it was read at', () => {
    const tab2 = { ...props, session: { ...props.session, paneId: '1' } }
    set({ entries: entries(RENDER_WINDOW + 5), sessionId: 's1' })
    const { rerender } = render(<ChatView {...props} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    const list = screen.getByRole('region', { name: 'Conversation' })
    layout(list, { scrollTop: 300 })
    fireEvent.scroll(list)
    // The other tab starts at its end
    set({ entries: entries(3), sessionId: 's2' })
    rerender(<ChatView {...tab2} />)
    expect(list.scrollTop).toBe(1000)
    expect(screen.queryByText('message 0')).toBeInTheDocument()
    // Back: the window shown and the scroll position, no jump offered
    set({ entries: entries(RENDER_WINDOW + 5), sessionId: 's1' })
    rerender(<ChatView {...props} />)
    expect(screen.getByText('message 0')).toBeInTheDocument()
    expect(list.scrollTop).toBe(300)
    expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull()
  })

  it('another view and back finds the place, with a jump to what came in meanwhile', () => {
    set({ entries: entries(5), sessionId: 's1' })
    const first = render(<ChatView {...props} />)
    const list = screen.getByRole('region', { name: 'Conversation' })
    layout(list, { scrollTop: 100 })
    fireEvent.scroll(list)
    first.unmount()
    set({ entries: entries(6), sessionId: 's1' })
    render(<ChatView {...props} />)
    const again = screen.getByRole('region', { name: 'Conversation' })
    expect(again.scrollTop).toBe(100)
    expect(
      screen.getByRole('button', { name: 'New messages' }),
    ).toBeInTheDocument()
  })

  it('a conversation left at its end opens at its end', () => {
    set({ entries: entries(5), sessionId: 's1' })
    const first = render(<ChatView {...props} />)
    first.unmount()
    set({ entries: entries(6), sessionId: 's1' })
    const { rerender } = render(<ChatView {...props} />)
    const list = screen.getByRole('region', { name: 'Conversation' })
    layout(list, { scrollTop: 0 })
    set({ entries: entries(7), sessionId: 's1' })
    rerender(<ChatView {...props} />)
    expect(list.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull()
  })

  it('only the latest hundred places are kept', () => {
    const leaveAt = (sessionId: string, scrollTop: number) => {
      set({ entries: entries(2), sessionId })
      const r = render(<ChatView {...props} />)
      const list = screen.getByRole('region', { name: 'Conversation' })
      layout(list, { scrollTop })
      fireEvent.scroll(list)
      r.unmount()
    }
    for (let i = 0; i <= 100; i++) leaveAt(`s${i}`, 100)
    const openAgain = (sessionId: string) => {
      set({ entries: entries(2), sessionId })
      const r = render(<ChatView {...props} />)
      const top = screen.getByRole('region', { name: 'Conversation' }).scrollTop
      r.unmount()
      return top
    }
    expect(openAgain('s100')).toBe(100)
    expect(openAgain('s0')).toBe(0)
  })

  it('a conversation still loading goes back to its place once it shows', () => {
    set({ entries: entries(5), sessionId: 's1' })
    const first = render(<ChatView {...props} />)
    layout(screen.getByRole('region', { name: 'Conversation' }), {
      scrollTop: 100,
    })
    fireEvent.scroll(screen.getByRole('region', { name: 'Conversation' }))
    first.unmount()
    set({ entries: entries(5), sessionId: 's1', loaded: false })
    const { rerender } = render(<ChatView {...props} />)
    set({ entries: entries(5), sessionId: 's1' })
    rerender(<ChatView {...props} />)
    expect(screen.getByRole('region', { name: 'Conversation' }).scrollTop).toBe(
      100,
    )
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
    expect(mockFollowPath).toHaveBeenCalledWith(
      '0',
      'pwa/src/a.ts',
      12,
      undefined,
    )
    expect(showView).toHaveBeenCalledWith('files')
    expect(
      screen.queryByRole('button', { name: 'window.location' }),
    ).not.toBeInTheDocument()
  })

  it('opens a range of lines in Files, marked from its first line', async () => {
    mockFollowPath.mockResolvedValue('opened')
    set({ entries: [say('See `pwa/src/repository.ts:391-398`.')] })
    render(<ChatView {...withFiles} />)
    const link = screen.getByRole('button', {
      name: 'pwa/src/repository.ts:391-398',
    })
    expect(link).toHaveAttribute(
      'title',
      'Open pwa/src/repository.ts:391-398 in Files',
    )
    await act(async () => fireEvent.click(link))
    expect(mockFollowPath).toHaveBeenCalledWith(
      '0',
      'pwa/src/repository.ts',
      391,
      [{ from: 391, to: 398 }],
    )
  })

  it('opens a list of lines in Files, each marked', async () => {
    mockFollowPath.mockResolvedValue('opened')
    set({ entries: [say('See `src/a.dto.ts:176,183`.')] })
    render(<ChatView {...withFiles} />)
    const link = screen.getByRole('button', { name: 'src/a.dto.ts:176,183' })
    expect(link).toHaveAttribute('title', 'Open src/a.dto.ts:176,183 in Files')
    await act(async () => fireEvent.click(link))
    expect(mockFollowPath).toHaveBeenCalledWith('0', 'src/a.dto.ts', 176, [
      { from: 176, to: 176 },
      { from: 183, to: 183 },
    ])
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
    expect(mockFollowPath).toHaveBeenCalledWith(
      '0',
      'docs/guide.md',
      4,
      undefined,
    )
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
    expect(mockFollowPath).toHaveBeenCalledWith('0', path, undefined, undefined)
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

  it('a link dropped for a newer one says nothing', async () => {
    mockFollowPath.mockResolvedValue('stale')
    set({ entries: [say('`src/a.ts`')] })
    render(<ChatView {...withFiles} />)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'src/a.ts' })),
    )
    expect(props.notify).not.toHaveBeenCalled()
    expect(showView).not.toHaveBeenCalled()
  })

  it('a file outside the folder the agent named opens in Files', async () => {
    mockFollowPath.mockResolvedValue('outside')
    mockOpenOutside.mockResolvedValue(null)
    set({ entries: [say('`/tmp/s/n.md`')] })
    render(<ChatView {...withFiles} />)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: '/tmp/s/n.md' })),
    )
    expect(mockOpenOutside).toHaveBeenCalledWith('0', '/tmp/s/n.md', {
      readOnly: false,
    })
    expect(showView).toHaveBeenCalledWith(FILES_VIEW_ID)
    expect(props.notify).not.toHaveBeenCalled()
  })

  it('outside, not opened: says why and stays', async () => {
    mockFollowPath.mockResolvedValue('outside')
    mockOpenOutside.mockResolvedValue('chat.view.outside')
    set({ entries: [say('`/tmp/s/n.md`')] })
    render(<ChatView {...withFiles} readOnly />)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: '/tmp/s/n.md' })),
    )
    expect(mockOpenOutside).toHaveBeenCalledWith('0', '/tmp/s/n.md', {
      readOnly: true,
    })
    expect(props.notify).toHaveBeenCalledWith(
      "This file is outside the pane's folder",
    )
    expect(showView).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', 'Not found'],
    ['failed', "This link can't be opened"],
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
    expect(screen.getByText('· 3 commands')).toBeInTheDocument()
    expect(screen.queryByText('Ran c1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /3 commands/ }))
    expect(screen.getByText('Ran c1')).toBeInTheDocument()
  })

  it('a live run keeps what the reader opened as it becomes a run', () => {
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2')],
      status: 'working',
    })
    const { rerender } = render(<ChatView {...props} />)
    // A click as a pointer makes it: pressed, then clicked
    fireEvent.pointerDown(screen.getByText('Output · 1 line'))
    fireEvent.click(screen.getByText('Output · 1 line'))
    expect(screen.getByText('r1')).toBeInTheDocument()
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2', 'r2'), bash('c3')],
      status: 'working',
    })
    rerender(<ChatView {...props} />)
    const run = screen.getByRole('button', { name: /^Working… · 3 commands/ })
    expect(run).toHaveAttribute('aria-expanded', 'true')
    // The card the reader opened stays; the others are a line each
    expect(screen.getByText('r1')).toBeInTheDocument()
    expect(screen.getByText('Ran c2')).toBeInTheDocument()
    // Done, the run the reader was in stays open until folded
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2', 'r2'), bash('c3', 'r3')],
      status: 'idle',
    })
    rerender(<ChatView {...props} />)
    expect(screen.getByText('Ran c3')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: /^Worked · 3 commands/ }),
    )
    expect(screen.queryByText('Ran c3')).toBeNull()
  })

  it('a live run folds once the agent is done, the reader at the bottom', () => {
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2', 'r2'), bash('c3')],
      status: 'working',
    })
    const { rerender } = render(<ChatView {...props} />)
    expect(screen.getByText('Ran c3')).toBeInTheDocument()
    set({
      entries: [
        entry(0),
        bash('c1', 'r1'),
        bash('c2', 'r2'),
        bash('c3', 'r3'),
        { id: 'a', role: 'assistant', parts: [{ kind: 'text', text: 'Done' }] },
      ],
      status: 'idle',
    })
    rerender(<ChatView {...props} />)
    expect(screen.queryByText('Ran c3')).toBeNull()
    expect(
      screen.getByRole('button', { name: /^Worked · 3 commands/ }),
    ).toHaveAttribute('aria-expanded', 'false')
  })

  it('read above when the agent is done, a run stays open until the bottom', () => {
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2', 'r2'), bash('c3')],
      status: 'working',
    })
    const { rerender } = render(<ChatView {...props} />)
    const list = screen.getByRole('region', { name: 'Conversation' })
    layout(list, { scrollTop: 100 })
    fireEvent.scroll(list)
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2', 'r2'), bash('c3', 'r3')],
      status: 'idle',
    })
    rerender(<ChatView {...props} />)
    expect(screen.getByText('Ran c3')).toBeInTheDocument()
    layout(list, { scrollTop: 800 })
    fireEvent.scroll(list)
    expect(screen.queryByText('Ran c3')).toBeNull()
  })

  it('a run focused inside stays open once the agent is done', () => {
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2', 'r2'), bash('c3')],
      status: 'working',
    })
    const { rerender } = render(<ChatView {...props} />)
    fireEvent.focus(screen.getByRole('button', { name: 'Ran c2' }))
    // Kept once: another press changes nothing
    fireEvent.pointerDown(screen.getByText('Ran c2'))
    set({
      entries: [entry(0), bash('c1', 'r1'), bash('c2', 'r2'), bash('c3', 'r3')],
      status: 'idle',
    })
    rerender(<ChatView {...props} />)
    expect(screen.getByText('Ran c3')).toBeInTheDocument()
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
    expect(screen.getByText(`Ran cmd${last - 5}`)).toBeInTheDocument()
    expect(screen.queryByText(`Ran cmd${last - 6}`)).toBeNull()
    const list = screen.getByRole('region', { name: 'Conversation' })
    layout(list, { scrollTop: 100 })
    fireEvent.scroll(list)
    // Each new step moves the window down one entry
    set({
      entries: [entry(0), ...steps(RENDER_WINDOW + 12)],
      status: 'working',
    })
    rerender(<ChatView {...props} />)
    expect(screen.getByText(`Ran cmd${last - 5}`)).toBeInTheDocument()
    expect(screen.getByText(`Ran cmd${last + 2}`)).toBeInTheDocument()
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
    expect(screen.queryByText('· 3 commands')).toBeNull()
  })

  it('without a status, a call waiting for its result keeps the last run open', () => {
    set({ entries: [entry(0), bash('c1', 'r'), bash('c2', 'r'), bash('c3')] })
    render(<ChatView {...props} />)
    expect(screen.getByText('Ran c1')).toBeInTheDocument()
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
    expect(screen.getByText('· 2 commands')).toBeInTheDocument()
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
    expect(screen.getByText('· 3 commands')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Show earlier messages' }),
    )
    expect(screen.getByText('· 4 commands')).toBeInTheDocument()
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

  it('shows the working line under the conversation while the agent works', () => {
    promptStore.activity = {
      label: 'Incubating',
      elapsed: 73,
      phase: 'hooks',
      detail: 'running Stop hooks… 0/3',
      tokens: '15.8k',
    }
    set({ entries: entries(1), status: 'working' })
    const { rerender } = render(<ChatView {...props} />)
    expect(screen.getByText('Incubating…').parentElement).toHaveTextContent(
      'Incubating… · running Stop hooks… 0/3 · 1m 13s · ↓ 15.8k tokens',
    )
    // Read out by phase, not by the second
    expect(screen.getByRole('status')).toHaveTextContent(
      'Incubating… running Stop hooks… 0/3',
    )
    // Not while a dialog is open, nor once the turn is over
    promptStore.prompt = {
      kind: 'permission',
      title: 'Bash command',
      options: [{ index: 1, label: 'Yes' }],
    }
    rerender(<ChatView {...props} />)
    expect(screen.queryByText('Incubating…')).toBeNull()
    promptStore.prompt = null
    set({ entries: entries(2), status: 'idle' })
    rerender(<ChatView {...props} />)
    expect(screen.queryByText('Incubating…')).toBeNull()
  })

  it('says what still runs once the turn is done', () => {
    promptStore.activity = {
      label: 'Cogitated',
      elapsed: 336,
      background: '2 shells',
    }
    set({ entries: entries(1), status: 'idle' })
    const { rerender } = render(<ChatView {...props} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Turn done · 2 shells still running',
    )
    expect(promptStore.livePane).toBe('0')
    // Not while a dialog is open
    promptStore.prompt = {
      kind: 'permission',
      title: 'Bash command',
      options: [{ index: 1, label: 'Yes' }],
    }
    rerender(<ChatView {...props} />)
    expect(screen.queryByText(/still running/)).toBeNull()
    // Working again: the end line read late is no working line
    promptStore.prompt = null
    set({ entries: entries(1), status: 'working' })
    rerender(<ChatView {...props} />)
    expect(screen.queryByText(/still running/)).toBeNull()
    expect(screen.queryByText('Cogitated…')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Claude Code is working…',
    )
    // Done with nothing left running: no row
    promptStore.activity = null
    set({ entries: entries(2), status: 'idle' })
    rerender(<ChatView {...props} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says the agent works when its screen gives no working line', () => {
    set({ entries: entries(1), status: 'working' })
    const { rerender } = render(<ChatView {...props} />)
    expect(screen.getByRole('status')).toHaveTextContent(
      'Claude Code is working…',
    )
    expect(promptStore.livePane).toBe('0')
    // An agent with no screen reader gets the row, without reading a screen
    rerender(
      <ChatView
        {...props}
        session={{ ...props.session, name: 'pi', agentName: 'pi' }}
      />,
    )
    expect(promptStore.livePane).toBeUndefined()
    expect(screen.getByRole('status')).toHaveTextContent('agent is working…')
  })

  it("shows a Claude session's running subagents under the conversation", () => {
    set({ entries: entries(1) })
    subagents.tree = {
      nodes: [
        {
          id: 'r1',
          type: 'seo-technical',
          status: 'running',
          tokens: 30_300,
          depth: 1,
          children: [],
        },
      ],
    }
    const { rerender } = render(<ChatView {...props} />)
    expect(subagents.panes).toContain('0')
    expect(
      screen.getByRole('button', { name: '1 subagent running' }),
    ).toBeInTheDocument()
    expect(screen.getByText('seo-technical')).toBeInTheDocument()
    // OpenCode's subagents are read as well
    subagents.panes = []
    rerender(
      <ChatView
        {...props}
        session={{ ...props.session, agentName: 'opencode' }}
      />,
    )
    expect(subagents.panes).toContain('0')
    // Another agent has no tree to read
    subagents.panes = []
    rerender(
      <ChatView
        {...props}
        session={{ ...props.session, agentName: 'codex' }}
      />,
    )
    expect(subagents.panes).toEqual([])
    expect(screen.queryByText('seo-technical')).toBeNull()
  })

  it("opens a Claude subagent's conversation, kept open when the strip goes", () => {
    set({ entries: entries(1) })
    const running = {
      id: 'r1',
      type: 'seo-technical',
      status: 'running' as const,
      depth: 1,
      children: [],
    }
    subagents.tree = { nodes: [running] }
    const { rerender } = render(<ChatView {...props} />)
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open the conversation of seo-technical',
      }),
    )
    expect(
      screen.getByRole('dialog', { name: 'subagent sheet' }),
    ).toHaveTextContent('0/r1')
    // The last running one ends: the strip goes, the sheet stays
    subagents.tree = { nodes: [{ ...running, status: 'done' }] }
    rerender(<ChatView {...props} />)
    expect(
      screen.queryByRole('button', { name: '1 subagent running' }),
    ).toBeNull()
    expect(
      screen.getByRole('dialog', { name: 'subagent sheet' }),
    ).toBeInTheDocument()
    // Another pane's Chat does not show it
    rerender(
      <ChatView {...props} session={{ ...props.session, paneId: '1' }} />,
    )
    expect(screen.queryByRole('dialog', { name: 'subagent sheet' })).toBeNull()
    rerender(<ChatView {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'close sheet' }))
    expect(screen.queryByRole('dialog', { name: 'subagent sheet' })).toBeNull()
  })

  it('has no subagent row to open for OpenCode or a view-only device', () => {
    set({ entries: entries(1) })
    subagents.tree = {
      nodes: [
        {
          id: 'r1',
          type: 'explore',
          status: 'running',
          depth: 1,
          children: [],
        },
      ],
    }
    const { rerender } = render(
      <ChatView
        {...props}
        session={{ ...props.session, agentName: 'opencode' }}
      />,
    )
    expect(screen.getByText('explore')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Open the conversation/ }),
    ).toBeNull()
    rerender(<ChatView {...props} readOnly />)
    expect(screen.getByText('explore')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Open the conversation/ }),
    ).toBeNull()
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
    expect(screen.getByText('agent')).toBeInTheDocument()
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
    expect(screen.getByText('Codex')).toBeInTheDocument()
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
      screen.getByText('Claude Code · rev⟨U+202E⟩iewer'),
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
    expect(screen.getByText('Claude Code · reviewer')).toBeInTheDocument()
  })

  it('a one-pane tab names its pane only when the user named it', () => {
    set({ entries: entries(1) })
    const one = (name?: string) => (
      <ChatView
        {...props}
        session={{
          ...props.session,
          paneId: 'p1',
          panes: [{ id: 'p1', label: name ?? 'claude', name, hasAgent: true }],
        }}
      />
    )
    const { rerender } = render(one('api'))
    expect(screen.getByText('Claude Code · api')).toBeInTheDocument()
    rerender(one())
    expect(screen.queryByText(/Claude Code · /)).toBeNull()
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
    error?: MessageKey,
  ): ViewProps => ({
    ...idle,
    agentStart: {
      starts: { 'w1:p1': { kind, phase, error, since: 0 } },
      start,
    },
  })

  it('offers every agent on an idle pane and starts the one picked', () => {
    render(<ChatView {...idle} />)
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    expect(start).toHaveBeenCalledWith('w1:p1', 'codex')
    fireEvent.click(screen.getByRole('button', { name: 'OpenCode' }))
    expect(start).toHaveBeenCalledWith('w1:p1', 'opencode')
    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeTruthy()
  })

  it('offers only Claude Code when the server cannot start Codex', () => {
    const mux = {
      ...idle.mux,
      caps: { ...idle.mux.caps, agentStartCodex: false },
    }
    render(<ChatView {...idle} mux={mux} />)
    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'OpenCode' })).toBeTruthy()
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
      <ChatView
        {...withStart('claude', 'failed', 'dialogs.startAgent.gone')}
      />,
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

describe('ChatView session history', () => {
  const history = vi.fn()
  const resumed = vi.fn()
  const sessions = [
    {
      agent: 'claude',
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      title: 'Old work',
      titleSource: 'ai',
      cwd: '',
      updatedAt: new Date().toISOString(),
    },
  ]
  const posts: unknown[] = []
  beforeEach(() => {
    history.mockReset()
    resumed.mockReset()
    posts.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/resume')) {
          posts.push(JSON.parse(init?.body as string))
          return new Response(JSON.stringify({ tabId: 't', paneId: 'p' }))
        }
        return new Response(JSON.stringify({ sessions, truncated: false }))
      }),
    )
    return () => vi.unstubAllGlobals()
  })
  const caps = {
    clientSideSelect: true,
    copyMode: false,
    agentChat: true,
    files: true,
    tasks: true,
  }
  const pane = (command: string): ViewProps => ({
    ...props,
    mux: { backend: 'tmux', caps },
    session: {
      id: 't1',
      name: 'tab',
      icon: '',
      description: '',
      paneId: 'p1',
      hasAgent: false,
      panes: [{ id: 'p1', label: 'Pane 1', hasAgent: false, command }],
    },
    openHistory: history,
    onSessionResumed: resumed,
  })

  it('opens the history from the header of a conversation', () => {
    set({ entries: entries(1) })
    const { rerender } = render(
      <ChatView
        {...props}
        mux={{ ...props.mux, caps: { ...props.mux.caps, files: true } }}
        openHistory={history}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Session history' }))
    expect(history).toHaveBeenCalledWith('0')
    // Not without pane folders
    rerender(<ChatView {...props} openHistory={history} />)
    expect(screen.queryByRole('button', { name: 'Session history' })).toBeNull()
  })

  it('offers the recent sessions of an idle pane, resumed in it', async () => {
    render(<ChatView {...pane('bash')} />)
    fireEvent.click(await screen.findByText('Old work'))
    expect(history).toHaveBeenCalledWith('p1', sessions[0])
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await vi.waitFor(() => expect(resumed).toHaveBeenCalled())
    expect(posts[0]).toMatchObject({ where: 'here' })
    expect(resumed.mock.calls[0][1]).toBe('here')
  })

  it('resumes in a new tab from a busy pane, and also next to a start', async () => {
    render(<ChatView {...pane('vim')} />)
    expect(screen.getByText('No agent runs in this pane.')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({ where: 'tab' })
  })

  it('beside a start, and without a handler for the result', async () => {
    const p = pane('bash')
    render(
      <ChatView
        {...p}
        mux={{ backend: 'herdr', caps: { ...caps, agentStart: true } }}
        agentStart={{ starts: {}, start: vi.fn() }}
        onSessionResumed={undefined}
      />,
    )
    expect(screen.getByText('Start an agent in this pane')).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await vi.waitFor(() => expect(posts).toHaveLength(1))
  })

  it('only reads for view-only or without tasks, and shows nothing without a way in', async () => {
    const { unmount } = render(<ChatView {...pane('bash')} readOnly />)
    await screen.findByText('Old work')
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    unmount()
    const noTasks = render(
      <ChatView
        {...pane('bash')}
        mux={{ backend: 'tmux', caps: { ...caps, tasks: false } }}
      />,
    )
    await screen.findByText('Old work')
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
    noTasks.unmount()
    render(<ChatView {...pane('bash')} openHistory={undefined} />)
    expect(screen.queryByText('Resume a recent session')).toBeNull()
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
