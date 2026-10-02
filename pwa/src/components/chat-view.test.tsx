import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import type { TranscriptState } from '../hooks/use-agent-transcript'
import type { AgentPrompt, TranscriptEntry } from '../hooks/use-mux-api'
import ChatView, { RENDER_WINDOW } from './chat-view'
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
vi.mock('../hooks/use-agent-transcript', () => ({
  useAgentTranscript: () => ({
    ...transcript.state,
    refresh: transcript.refresh,
    loadOlder: transcript.loadOlder,
  }),
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
        session={{ ...props.session, name: 'codex', agentName: 'codex' }}
      />,
    )
    expect(promptStore.pane).toBeUndefined()
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
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          fire = cb
        }
        observe() {}
        disconnect = disconnect
      },
    )
    set({ entries: entries(3) })
    const { unmount } = render(<ChatView {...props} />)
    const list = screen.getByRole('region', { name: 'Conversation' })
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

describe('OpenTerminalButton', () => {
  it('switches to the terminal view', () => {
    render(<OpenTerminalButton showView={showView} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(showView).toHaveBeenCalledWith('terminal')
  })
})
