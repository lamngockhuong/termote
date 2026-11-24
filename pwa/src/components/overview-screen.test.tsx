import { act, fireEvent, render, screen, within } from '@testing-library/react'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest'
import type { Session, SessionGroup, SessionPane } from '../types/session'

const {
  mockFetchOverview,
  mockFetchActivity,
  mockFetchUsage,
  mockTranscript,
  mockSendMessage,
  mockInterrupt,
  mockFetchJobs,
  mockFetchAsks,
  mockFetchSubagents,
  mockFetchPrompt,
  mockAnswer,
} = vi.hoisted(() => ({
  mockFetchPrompt: vi.fn(),
  mockAnswer: vi.fn(),
  mockFetchJobs: vi.fn(),
  mockFetchAsks: vi.fn(),
  mockFetchOverview: vi.fn(),
  mockFetchActivity: vi.fn(),
  mockFetchUsage: vi.fn(),
  mockTranscript: vi.fn(),
  mockSendMessage: vi.fn(),
  mockInterrupt: vi.fn(),
  mockFetchSubagents: vi.fn(),
}))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchOverview: () => mockFetchOverview(),
  fetchActivity: (after?: number) => mockFetchActivity(after),
  fetchUsageSummary: (pane?: string) => mockFetchUsage(pane),
  fetchTranscript: (pane: string) => mockTranscript(pane),
  sendAgentMessage: (pane: string, text: string, cursor: string) =>
    mockSendMessage(pane, text, cursor),
  interruptAgent: (...a: unknown[]) => mockInterrupt(...a),
  fetchJobs: () => mockFetchJobs(),
  fetchAsks: () => mockFetchAsks(),
  fetchSubagents: (pane: string) => mockFetchSubagents(pane),
  fetchAgentPrompt: async (pane: string) => ({
    prompt: await mockFetchPrompt(pane),
    activity: null,
  }),
  answerAgentPrompt: (...a: unknown[]) => mockAnswer(...a),
}))
// The sheet itself is SubagentTranscriptSheet's own test: here a stand-in
// that names what it shows and closes.
vi.mock('./subagent-transcript-sheet', () => ({
  SubagentTranscriptSheet: (p: {
    target?: { paneId: string; node: { id: string } }
    onClose: () => void
    notify: (message: string) => void
  }) =>
    p.target ? (
      <div role="dialog" aria-label="subagent sheet">
        {p.target.paneId}/{p.target.node.id}
        {/* A copy notifies through the overview's own notify */}
        <button type="button" onClick={() => p.notify('Copied')}>
          copy in sheet
        </button>
        <button type="button" onClick={p.onClose}>
          close sheet
        </button>
      </div>
    ) : null,
}))

import { resetActivityLog } from '../hooks/use-activity-log'
import { resetAgentOverview } from '../hooks/use-agent-overview'
import { resetAgentPromptStores } from '../hooks/use-agent-prompt'
import { reloadJobs, resetJobs } from '../hooks/use-jobs'
import { AgentRequestError, RequestError } from '../hooks/use-mux-api'
import { agentCards } from '../utils/agent-cards'
import { OVERVIEW_TICK, OverviewScreen } from './overview-screen'

const NOW = Date.parse('2026-10-13T09:10:00Z')

const tab = (
  id: string,
  groupId: string,
  panes: Session['panes'],
): Session => ({
  id,
  name: id,
  icon: '📺',
  description: '',
  groupId,
  panes,
})

const SESSIONS: Session[] = [
  tab('t1', 'g1', [
    {
      id: 'p-idle',
      label: 'claude',
      hasAgent: true,
      agentName: 'claude',
      agentStatus: 'idle',
    },
    { id: 'p-shell', label: 'shell', hasAgent: false },
  ]),
  tab('t2', 'g2', [
    {
      id: 'p-new',
      label: 'codex',
      hasAgent: true,
      agentName: 'codex',
      agentStatus: 'working',
      agentSince: '2026-10-13T09:08:00Z',
    },
  ]),
  tab('t3', 'g2', [
    {
      id: 'p-old',
      label: 'claude',
      hasAgent: true,
      agentName: 'claude',
      agentStatus: 'working',
      agentSince: '2026-10-13T09:01:00Z',
    },
    {
      id: 'p-blocked',
      label: 'claude',
      hasAgent: true,
      agentName: 'claude',
      agentStatus: 'blocked',
    },
  ]),
  { id: 'loose', name: 'loose', icon: '', description: '' },
]
const GROUPS: SessionGroup[] = [
  { id: 'g1', name: 'api' },
  { id: 'g2', name: 'web', worktree: { linked: true } },
]

function renderScreen(
  props: Partial<Parameters<typeof OverviewScreen>[0]> = {},
) {
  const onOpen = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <OverviewScreen
      sessions={SESSIONS}
      groups={GROUPS}
      groupNoun="workspace"
      ready
      pollInterval={5000}
      clockOffset={0}
      activePaneOnly={false}
      opensChat={(p) => p.agentName === 'claude'}
      canAnswer={(p) => p.agentName === 'claude'}
      readOnly={false}
      stuckMinutes={10}
      onOpen={onOpen}
      onClose={onClose}
      {...props}
    />,
  )
  return { ...utils, onOpen, onClose }
}

// The card buttons (agent, status, place), not their terminal buttons
const cardNames = () =>
  screen
    .queryAllByRole('button', { name: /^Open (chat|terminal): [^,]+, [^,]+, / })
    .filter((b) => b.closest('li[data-card]'))
    .map((b) => b.getAttribute('aria-label'))
// The list of the cards (a dialog to answer has lists of its own)
const cardList = () =>
  document.querySelector('li[data-card]')?.parentElement as HTMLElement

describe('OverviewScreen', () => {
  beforeEach(() => {
    mockFetchUsage.mockRejectedValue(new Error('no usage'))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    resetAgentOverview()
    resetActivityLog()
    resetJobs()
    resetAgentPromptStores()
    // No dialog read: the queue's card offers the terminal
    mockFetchPrompt.mockRejectedValue(new Error('no dialog'))
    mockFetchJobs.mockResolvedValue({
      jobs: [],
      readOnly: false,
      canGrant: false,
      serverNow: '2026-10-13T09:10:00Z',
    })
    mockFetchActivity.mockResolvedValue({
      events: [
        {
          seq: 0,
          ts: '2026-10-13T09:00:00Z',
          key: 'p-new',
          groupId: 'g2',
          tabId: 't2',
          paneId: 'p-new',
          agent: 'codex',
          from: '',
          to: 'working',
        },
        {
          seq: 1,
          ts: '2026-10-13T09:01:00Z',
          key: 'p-blocked',
          groupId: 'g2',
          tabId: 't3',
          paneId: 'p-blocked',
          agent: 'claude',
          from: 'working',
          to: 'blocked',
        },
      ],
      latest: 1,
      oldest: 1,
      reset: true,
      serverNow: '2026-10-13T09:10:00Z',
    })
    mockFetchOverview.mockResolvedValue({
      serverNow: '2026-10-13T09:10:00Z',
      panes: [
        {
          paneId: 'p-blocked',
          key: 'p-blocked',
          lastText: 'Run the migration?',
        },
      ],
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the activity log as a sheet, and a row opens its pane', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    const { onOpen } = renderScreen()
    await act(async () => {})
    const button = screen.getByRole('button', { name: 'Activity' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-pressed', 'true')
    const sheet = screen.getByRole('dialog', { name: 'Activity' })
    const row = within(sheet).getByRole('button', { name: /Claude Code/ })
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(
      SESSIONS[2],
      SESSIONS[2].panes![1],
      'chat',
    )
    expect(screen.queryByRole('dialog', { name: 'Activity' })).toBeNull()
    // A pane without a Chat view opens on its terminal.
    fireEvent.click(button)
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Codex/ }),
    )
    expect(onOpen).toHaveBeenLastCalledWith(
      SESSIONS[1],
      SESSIONS[1].panes![0],
      'terminal',
    )
    // Its close button closes it too.
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: 'Close the activity' }))
    expect(screen.queryByRole('dialog', { name: 'Activity' })).toBeNull()
  })

  it('shows the activity log beside the cards on a wide screen', async () => {
    const orig = window.matchMedia
    window.matchMedia = ((query: string) => ({
      ...orig(query),
      matches: query === '(min-width: 1280px)',
    })) as typeof window.matchMedia
    try {
      renderScreen()
      await act(async () => {})
      fireEvent.click(screen.getByRole('button', { name: 'Activity' }))
      expect(screen.queryByRole('dialog')).toBeNull()
      const aside = screen.getByRole('complementary', { name: 'Activity' })
      expect(within(aside).getAllByRole('listitem')).toHaveLength(2)
      // The card's strip reads the same events.
      fireEvent.click(screen.getAllByRole('button', { name: 'History' })[0])
      expect(
        screen.getByRole('img', { name: /^Last 60 min: needs you 9 min/ }),
      ).toBeInTheDocument()
    } finally {
      window.matchMedia = orig
    }
  })

  it('the answered card stays once no agent waits any more, until Done', async () => {
    let open = true
    mockFetchPrompt.mockImplementation(async () =>
      open
        ? {
            kind: 'permission',
            promptId: 'id-1',
            title: 'Run the migration?',
            options: [
              { index: 1, label: 'Yes' },
              { index: 2, label: 'No' },
            ],
          }
        : null,
    )
    mockAnswer.mockImplementation(async () => {
      open = false
    })
    const { rerender } = renderScreen()
    const queue = await screen.findByRole('region', {
      name: /^Needs you: Claude Code, web \/ t3/,
    })
    await within(queue).findByText('Run the migration?')
    await act(async () =>
      fireEvent.click(within(queue).getByRole('button', { name: /1\.\s*Yes/ })),
    )
    await within(queue).findByText('Answered.')
    // The next snapshot: the agent works, nothing waits on the user
    const working = SESSIONS.map((s) => ({
      ...s,
      panes: s.panes?.map((p) =>
        p.id === 'p-blocked' ? { ...p, agentStatus: 'working' as const } : p,
      ),
    }))
    rerender(
      <OverviewScreen
        sessions={working}
        groups={GROUPS}
        groupNoun="workspace"
        ready
        pollInterval={5000}
        clockOffset={0}
        activePaneOnly={false}
        opensChat={(p) => p.agentName === 'claude'}
        canAnswer={(p) => p.agentName === 'claude'}
        readOnly={false}
        stuckMinutes={10}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(within(queue).getByText('Answered.')).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTimeAsync(500))
    fireEvent.click(within(queue).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('region', { name: /^Needs you: / })).toBeNull()
  })

  it('lists every agent, the ones waiting on the user first', async () => {
    renderScreen()
    await act(async () => {})
    expect(cardNames()).toEqual([
      'Open chat: Claude Code, Needs you, web / t3',
      'Open terminal: Codex, Working, web / t2',
      'Open chat: Claude Code, Working, web / t3',
      'Open chat: Claude Code, Idle, api / t1',
    ])
    expect(screen.getByText('Run the migration?')).toBeInTheDocument()
    expect(screen.getAllByText('worktree')).toHaveLength(3)
    expect(screen.queryByText(/active pane of each window/)).toBeNull()
  })

  it('filters by its own filter, counting agents', async () => {
    renderScreen()
    await act(async () => {})
    fireEvent.click(screen.getByRole('radio', { name: 'Working, 2 agents' }))
    expect(cardNames()).toHaveLength(2)
    fireEvent.click(screen.getByRole('radio', { name: 'Needs you, 1 agent' }))
    expect(cardNames()).toEqual(['Open chat: Claude Code, Needs you, web / t3'])
    expect(screen.queryByRole('radio', { name: /^Agents/ })).toBeNull()
  })

  it("opens a Claude subagent's conversation, kept open when its card goes", async () => {
    mockFetchSubagents.mockResolvedValue({
      nodes: [
        { id: 'a1', type: 'Explore', status: 'done', depth: 1, children: [] },
      ],
    })
    renderScreen()
    await act(async () => {})
    const card = screen
      .getByRole('button', { name: /^Open chat: Claude Code, Idle/ })
      .closest('li') as HTMLElement
    await act(async () =>
      fireEvent.click(within(card).getByRole('button', { name: 'History' })),
    )
    fireEvent.click(
      within(card).getByRole('button', {
        name: 'Open the conversation of Explore',
      }),
    )
    const sheet = screen.getByRole('dialog', { name: 'subagent sheet' })
    expect(sheet).toHaveTextContent('p-idle/a1')
    // Filtered out, the card goes; the sheet stays
    fireEvent.click(screen.getByRole('radio', { name: 'Working, 2 agents' }))
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(
      screen.queryByRole('button', { name: /^Open chat: Claude Code, Idle/ }),
    ).toBeNull()
    expect(screen.getByRole('dialog', { name: 'subagent sheet' })).toBe(sheet)
    // Without a notify of the App's, a copy says nothing
    fireEvent.click(screen.getByRole('button', { name: 'copy in sheet' }))
    fireEvent.click(screen.getByRole('button', { name: 'close sheet' }))
    expect(screen.queryByRole('dialog', { name: 'subagent sheet' })).toBeNull()
  })

  it('has no subagent row to open on a view-only device or for OpenCode', async () => {
    mockFetchSubagents.mockResolvedValue({
      nodes: [
        { id: 'a1', type: 'Explore', status: 'done', depth: 1, children: [] },
      ],
    })
    const opencode = tab('t9', 'g1', [
      {
        id: 'p-oc',
        label: 'opencode',
        hasAgent: true,
        agentName: 'opencode',
        agentStatus: 'idle',
      },
    ])
    const { rerender } = renderScreen({
      readOnly: true,
      sessions: [SESSIONS[0]],
    })
    await act(async () => {})
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /^History/ })),
    )
    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Open the conversation/ }),
    ).toBeNull()
    rerender(
      <OverviewScreen
        sessions={[opencode]}
        groups={GROUPS}
        groupNoun="workspace"
        ready
        pollInterval={5000}
        clockOffset={0}
        activePaneOnly={false}
        opensChat={() => true}
        canAnswer={() => true}
        readOnly={false}
        stuckMinutes={10}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /^History/ })),
    )
    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^Open the conversation/ }),
    ).toBeNull()
  })

  it('says when no agent matches, and shows all again', () => {
    renderScreen({ sessions: [SESSIONS[0]] })
    fireEvent.click(screen.getByRole('radio', { name: 'Needs you, 0 agents' }))
    expect(screen.getByText('No agents match')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(cardNames()).toHaveLength(1)
  })

  describe('search', () => {
    const openSearch = () =>
      fireEvent.click(screen.getByRole('button', { name: 'Search agents' }))
    const type = (q: string) =>
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: q } })

    it('narrows the cards by tab, group, agent and pane', () => {
      renderScreen()
      expect(screen.queryByRole('searchbox')).toBeNull()
      openSearch()
      expect(
        screen.getByRole('searchbox', { name: 'Find an agent' }),
      ).toHaveFocus()
      type('t1')
      expect(cardNames()).toEqual(['Open chat: Claude Code, Idle, api / t1'])
      type('web')
      expect(cardNames()).toHaveLength(3)
      type('codex')
      expect(cardNames()).toHaveLength(1)
      type('WEB claude')
      expect(cardNames()).toHaveLength(2)
    })

    it('leaves the Needs you queue whole', () => {
      renderScreen()
      openSearch()
      type('t1')
      expect(
        screen.getByRole('heading', {
          name: /^Needs you: Claude Code, web \/ t3/,
        }),
      ).toBeInTheDocument()
    })

    it('narrows the status filter, and Show all clears both', () => {
      renderScreen()
      fireEvent.click(screen.getByRole('radio', { name: 'Needs you, 1 agent' }))
      openSearch()
      type('t1')
      expect(screen.getByText('No agents match')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
      expect(cardNames()).toHaveLength(4)
      expect(screen.getByRole('searchbox')).toHaveValue('')
    })

    it('Enter opens the first card on its view, ArrowDown focuses it', () => {
      const { onOpen } = renderScreen()
      openSearch()
      type('codex')
      const box = screen.getByRole('searchbox')
      fireEvent.keyDown(box, { key: 'Enter' })
      expect(onOpen).toHaveBeenCalledWith(
        SESSIONS[1],
        SESSIONS[1].panes![0],
        'terminal',
      )
      fireEvent.keyDown(box, { key: 'ArrowDown' })
      expect(
        screen.getByRole('button', { name: /^Open terminal: Codex/ }),
      ).toHaveFocus()
      // A Claude card opens its chat
      type('t1')
      fireEvent.keyDown(box, { key: 'Enter' })
      expect(onOpen).toHaveBeenLastCalledWith(
        SESSIONS[0],
        SESSIONS[0].panes![0],
        'chat',
      )
    })

    it('Enter and ArrowDown do nothing without a match', () => {
      const { onOpen } = renderScreen()
      openSearch()
      type('zzz')
      const box = screen.getByRole('searchbox')
      fireEvent.keyDown(box, { key: 'Enter' })
      fireEvent.keyDown(box, { key: 'ArrowDown' })
      expect(onOpen).not.toHaveBeenCalled()
      expect(box).toHaveFocus()
    })

    it('Esc clears the box and does not close the overview', () => {
      const { onClose } = renderScreen()
      openSearch()
      type('t1')
      const box = screen.getByRole('searchbox')
      const esc = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      })
      act(() => {
        box.dispatchEvent(esc)
      })
      expect(esc.defaultPrevented).toBe(true)
      expect(box).toHaveValue('')
      fireEvent.keyDown(box, { key: 'Escape' })
      expect(screen.queryByRole('searchbox')).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('the magnifier closes the box, cleared', () => {
      renderScreen()
      openSearch()
      type('t1')
      fireEvent.click(
        screen.getAllByRole('button', { name: 'Close the search' })[0],
      )
      expect(screen.queryByRole('searchbox')).toBeNull()
      expect(cardNames()).toHaveLength(4)
    })

    it('has no magnifier with no agent', () => {
      renderScreen({ sessions: [SESSIONS[3]] })
      expect(screen.queryByRole('button', { name: 'Search agents' })).toBeNull()
    })
  })

  it('opens a card on its chat or terminal, and closes', () => {
    const { onOpen, onClose } = renderScreen()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open chat: Claude Code, Needs you, web / t3',
      }),
    )
    expect(onOpen).toHaveBeenLastCalledWith(
      SESSIONS[2],
      SESSIONS[2].panes?.[1],
      'chat',
    )
    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'Open terminal: Claude Code, web / t3',
      })[0],
    )
    expect(onOpen).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      'terminal',
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open terminal: Codex, Working, web / t2',
      }),
    )
    expect(onOpen).toHaveBeenLastCalledWith(
      SESSIONS[1],
      SESSIONS[1].panes?.[0],
      'terminal',
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Close the agent overview' }),
    )
    expect(onClose).toHaveBeenCalled()
  })

  it('a single group names only the tab; tmux notes the active pane', () => {
    renderScreen({
      sessions: [SESSIONS[0]],
      groups: [GROUPS[0]],
      activePaneOnly: true,
    })
    expect(cardNames()).toEqual(['Open chat: Claude Code, Idle, t1'])
    expect(screen.getByText(/active pane of each window/)).toBeInTheDocument()
  })

  it('without an agent, offers to start one when it can', () => {
    const onStartAgent = vi.fn()
    const { unmount } = renderScreen({ sessions: [SESSIONS[3]], onStartAgent })
    expect(screen.getByText(/No agent is running/)).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: 'Start an agent in this pane' }),
    )
    expect(onStartAgent).toHaveBeenCalled()
    unmount()
    renderScreen({ sessions: [] })
    expect(screen.queryByRole('button', { name: /Start an agent/ })).toBeNull()
  })

  it('moves its clock every 30 s, from the server time', async () => {
    renderScreen({ sessions: [SESSIONS[1]], clockOffset: 60_000 })
    expect(cardList()).toHaveTextContent('3 min ago')
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_TICK * 2)
    })
    expect(cardList()).toHaveTextContent('4 min ago')
  })
})

describe('OverviewScreen, a tab without a group', () => {
  it('names the tab only', () => {
    resetAgentOverview()
    mockFetchOverview.mockResolvedValue({ serverNow: 'x', panes: [] })
    render(
      <OverviewScreen
        sessions={[
          {
            id: 'solo',
            name: 'solo',
            icon: '',
            description: '',
            panes: [
              { id: 'p', label: 'claude', hasAgent: true, agentName: 'claude' },
            ],
          },
        ]}
        groups={GROUPS}
        groupNoun="workspace"
        ready
        pollInterval={5000}
        clockOffset={0}
        activePaneOnly={false}
        opensChat={() => false}
        canAnswer={() => false}
        readOnly={false}
        stuckMinutes={10}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', {
        name: 'Open terminal: Claude Code, status unknown, solo',
      }),
    ).toBeInTheDocument()
  })
})

describe('OverviewScreen, loading and failing', () => {
  beforeEach(() => {
    resetAgentOverview()
    mockFetchOverview.mockResolvedValue({ serverNow: 'x', panes: [] })
    mockFetchUsage.mockRejectedValue(new Error('no usage'))
  })

  it("shows every session's tokens today and in 7 days", async () => {
    mockFetchUsage.mockResolvedValue({
      buckets: [
        {
          t: new Date().toISOString(),
          agent: 'codex',
          tokens: 2000,
          costUsd: 1.5,
        },
      ],
      since: 'x',
      truncated: false,
      pricesUpdated: '2026-11-15',
    })
    renderScreen()
    await act(async () => {})
    expect(mockFetchUsage).toHaveBeenCalledWith(undefined)
    // Today's tokens on the header, the rest behind it
    expect(screen.queryByRole('region', { name: 'Agent tokens' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Tokens today: 2.0k' }))
    expect(
      screen.getByRole('region', { name: 'Agent tokens' }),
    ).toHaveTextContent('Today7 daysCodex~$1.50~$1.50tokens2.0k2.0k')
  })

  it('shows the Codex accounts behind the header tokens', async () => {
    mockFetchOverview.mockResolvedValue({
      serverNow: 'x',
      panes: [],
      accounts: [
        {
          key: 'k1',
          agent: 'codex',
          plan: 'team',
          windows: [{ usedPercent: 12, windowMinutes: 300 }],
          updatedAt: new Date().toISOString(),
        },
      ],
    })
    renderScreen()
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Tokens today: 0' }))
    expect(screen.getByRole('region', { name: 'Accounts' })).toHaveTextContent(
      'Codex · team5h12%updated just now',
    )
  })

  it('shows one Stop refusal at a time, the latest replacing the one before', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const working = (id: string): SessionPane => ({
      id,
      label: 'claude',
      hasAgent: true,
      agentName: 'claude',
      agentStatus: 'working',
      agentSince: '2026-10-13T09:01:00Z',
    })
    mockFetchOverview.mockResolvedValue({
      serverNow: '2026-10-13T09:10:00Z',
      panes: [
        { paneId: 'p-a', key: 'p-a', cursor: 'ca' },
        { paneId: 'p-b', key: 'p-b', cursor: 'cb' },
      ],
    })
    mockInterrupt
      .mockRejectedValueOnce(new AgentRequestError(409, 'agent_blocked', 'no'))
      .mockRejectedValueOnce(new TypeError('offline'))
    renderScreen({
      sessions: [
        tab('ta', 'g1', [working('p-a')]),
        tab('tb', 'g1', [working('p-b')]),
      ],
    })
    await act(async () => {})
    const stops = screen.getAllByRole('button', { name: /^Stop Claude Code, / })
    expect(stops).toHaveLength(2)
    await act(async () => {
      fireEvent.click(stops[0])
    })
    expect(
      screen.getByText(
        'Claude Code was not stopped: The agent waits for an answer to a dialog',
      ),
    ).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(stops[1])
    })
    expect(screen.getAllByText(/was not stopped/)).toHaveLength(1)
    expect(screen.queryByText(/waits for an answer to a dialog/)).toBeNull()
    // It goes away by itself.
    await act(async () => {
      vi.advanceTimersByTime(10_000)
    })
    expect(screen.queryByText(/was not stopped/)).toBeNull()
  })

  it('says nothing about agents before the first snapshot', () => {
    renderScreen({ sessions: [], ready: false })
    expect(screen.queryByText(/No agent is running/)).toBeNull()
  })

  it('says when the details could not be read', async () => {
    mockFetchOverview.mockRejectedValue(new Error('down'))
    renderScreen()
    expect(
      await screen.findByText(/Could not read the agents' details/),
    ).toHaveAttribute('role', 'status')
    expect(screen.getAllByTitle(/^workspace /)[0]).toHaveTextContent('web / t3')
  })

  it('takes the focus, and gives it back when closed', () => {
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const { unmount } = renderScreen()
    expect(screen.getByRole('heading', { name: 'Agents' })).toHaveFocus()
    unmount()
    expect(opener).toHaveFocus()
    opener.remove()
  })

  it('focuses the card it was opened on, marked until focus leaves it', () => {
    const { rerender, onOpen, onClose } = renderScreen({
      focusPane: { paneId: 'p-new' },
    })
    const card = screen.getByRole('button', { name: /^Open terminal: Codex,/ })
    const frame = () => card.closest('[data-status]') as HTMLElement
    expect(card).toHaveFocus()
    expect(frame()).toHaveAttribute('data-highlighted', 'true')
    // Within the card the mark stays; out of it, it goes.
    const inside = within(frame()).getAllByRole('button')[1]
    act(() => inside.focus())
    expect(frame()).toHaveAttribute('data-highlighted', 'true')
    act(() => screen.getByRole('heading', { name: 'Agents' }).focus())
    expect(frame()).not.toHaveAttribute('data-highlighted')
    // Another card losing focus leaves the mark as it is.
    act(() =>
      screen.getAllByRole('button', { name: /^Open chat: / })[0].focus(),
    )
    act(() => screen.getByRole('heading', { name: 'Agents' }).focus())
    expect(document.querySelector('[data-highlighted]')).toBeNull()

    const props = {
      sessions: SESSIONS,
      groups: GROUPS,
      groupNoun: 'workspace',
      ready: true,
      pollInterval: 5000,
      clockOffset: 0,
      activePaneOnly: false,
      opensChat: (p: SessionPane) => p.agentName === 'claude',
      canAnswer: (p: SessionPane) => p.agentName === 'claude',
      readOnly: false,
      stuckMinutes: 10,
      onOpen,
      onClose,
    }
    // A new request focuses again; the same one again does nothing.
    const same = { paneId: 'p-new' }
    rerender(<OverviewScreen {...props} focusPane={same} />)
    expect(card).toHaveFocus()
    act(() => screen.getByRole('heading', { name: 'Agents' }).focus())
    rerender(<OverviewScreen {...props} focusPane={same} />)
    expect(screen.getByRole('heading', { name: 'Agents' })).toHaveFocus()
  })

  it('focuses no card before the snapshot is in, nor after the user moved on', () => {
    const props = {
      sessions: SESSIONS,
      groups: GROUPS,
      groupNoun: 'workspace',
      pollInterval: 5000,
      clockOffset: 0,
      activePaneOnly: false,
      opensChat: (p: SessionPane) => p.agentName === 'claude',
      canAnswer: (p: SessionPane) => p.agentName === 'claude',
      readOnly: false,
      stuckMinutes: 10,
      onOpen: vi.fn(),
      onClose: vi.fn(),
      focusPane: { paneId: 'p-new' },
    }
    // The server out of reach: its sessions are kept, no card is drawn
    const { rerender } = render(<OverviewScreen {...props} ready={false} />)
    const close = screen.getByRole('button', {
      name: 'Close the agent overview',
    })
    act(() => close.focus())
    rerender(<OverviewScreen {...props} ready />)
    expect(close).toHaveFocus()
    expect(document.querySelector('[data-highlighted]')).toBeNull()
  })

  it('keeps the focus on the title for a pane without a card', () => {
    renderScreen({ focusPane: { paneId: 'p-shell' } })
    expect(screen.getByRole('heading', { name: 'Agents' })).toHaveFocus()
    expect(document.querySelector('[data-highlighted]')).toBeNull()
  })
})

describe('OverviewScreen, stuck agents', () => {
  it('marks a working agent quiet past the setting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    resetAgentOverview()
    mockFetchOverview.mockResolvedValue({
      serverNow: 'x',
      panes: [
        { paneId: 'p-old', key: 'p-old', lastTs: '2026-10-13T09:00:00Z' },
        { paneId: 'p-new', key: 'p-new', lastTs: '2026-10-13T09:09:00Z' },
      ],
    })
    renderScreen({ stuckMinutes: 10 })
    expect(
      await screen.findByText('May be stuck: no new activity for 10 min'),
    ).toBeInTheDocument()
    expect(screen.getAllByText(/May be stuck/)).toHaveLength(1)
    vi.useRealTimers()
  })
})

describe('agentCards', () => {
  it('takes the panes running an agent, in order', () => {
    expect(agentCards(SESSIONS).map((c) => c.pane.id)).toEqual([
      'p-idle',
      'p-new',
      'p-old',
      'p-blocked',
    ])
  })

  describe('OverviewScreen cards coming and going', () => {
    beforeEach(() => {
      resetAgentOverview()
      mockFetchOverview.mockResolvedValue({ serverNow: 'x', panes: [] })
      mockFetchActivity.mockResolvedValue({ events: [] })
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('fades in a card for a later agent, and fades out one whose pane went', () => {
      // The cards' transition, as the stylesheet gives it in a browser
      const real = window.getComputedStyle
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
        el.tagName === 'LI'
          ? ({
              transitionDuration: '0.2s',
              transitionDelay: '0s',
            } as CSSStyleDeclaration)
          : real(el),
      )
      const later = tab('t9', 'g1', [
        {
          id: 'p-later',
          label: 'aider',
          hasAgent: true,
          agentName: 'aider',
          agentStatus: 'working',
        },
      ])
      const { rerender, onOpen, onClose } = renderScreen()
      const props = {
        groups: GROUPS,
        groupNoun: 'workspace' as const,
        ready: true,
        pollInterval: 5000,
        clockOffset: 0,
        activePaneOnly: false,
        opensChat: () => false,
        canAnswer: () => false,
        readOnly: false,
        stuckMinutes: 10,
        onOpen,
        onClose,
      }
      const items = () => [
        ...document.querySelectorAll<HTMLElement>('li[data-card]'),
      ]
      const before = items().length
      rerender(<OverviewScreen {...props} sessions={[...SESSIONS, later]} />)
      const added = items().filter((li) =>
        li.className.includes('motion-safe:starting:opacity-0'),
      )
      expect(added).toHaveLength(1)
      expect(added[0]).toHaveTextContent('aider')
      rerender(<OverviewScreen {...props} sessions={[SESSIONS[0], later]} />)
      const leaving = items().filter((li) => li.hasAttribute('data-leaving'))
      expect(leaving.length).toBe(before - 1)
      for (const li of leaving) {
        expect(li).toHaveAttribute('inert')
        expect(li).toHaveClass('pointer-events-none', 'opacity-0')
      }
      act(() => {
        for (const li of leaving) li.dispatchEvent(new Event('transitionend'))
      })
      expect(items()).toHaveLength(2)
    })
  })

  describe('sending one message to several agents', () => {
    const selectButton = () =>
      screen.getByRole('button', { name: 'Send a message to several agents' })
    const boxes = () => screen.queryAllByRole('checkbox')
    const field = () =>
      screen.getByRole('textbox', { name: 'Message for the agents picked' })

    beforeEach(() => {
      mockTranscript.mockReset()
      mockSendMessage.mockReset()
      mockTranscript.mockResolvedValue({ cursor: 'c' })
    })

    it('offers no picking in view-only, nor without an agent to take it', async () => {
      const { unmount } = renderScreen({ readOnly: true })
      await act(async () => {})
      expect(
        screen.queryByRole('button', {
          name: 'Send a message to several agents',
        }),
      ).toBeNull()
      expect(boxes()).toHaveLength(0)
      expect(screen.queryByRole('textbox')).toBeNull()
      unmount()
      renderScreen({ canAnswer: () => false })
      await act(async () => {})
      expect(
        screen.queryByRole('button', {
          name: 'Send a message to several agents',
        }),
      ).toBeNull()
    })

    it('picks only the agents that take a message, until picking stops', async () => {
      renderScreen()
      await act(async () => {})
      expect(boxes()).toHaveLength(0)
      fireEvent.click(screen.getAllByRole('button', { name: 'History' })[0])
      fireEvent.click(selectButton())
      expect(selectButton()).toHaveAttribute('aria-pressed', 'true')
      // The cards are not drawn anew: an open history stays open
      expect(
        screen.getAllByRole('button', { name: 'Hide history' }),
      ).toHaveLength(1)
      // The three Claude Code agents, not Codex
      expect(boxes()).toHaveLength(3)
      expect(
        screen.getByRole('checkbox', { name: 'Pick Claude Code, api / t1' }),
      ).not.toBeChecked()
      expect(screen.getByText('Pick the agents to send to')).toBeInTheDocument()
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Pick Claude Code, api / t1' }),
      )
      expect(screen.getByText('1 agent picked')).toBeInTheDocument()
      // Stopping unpicks everything and hides the bar
      fireEvent.click(selectButton())
      expect(boxes()).toHaveLength(0)
      expect(screen.queryByRole('textbox')).toBeNull()
      fireEvent.click(selectButton())
      expect(
        boxes().filter((b) => (b as HTMLInputElement).checked),
      ).toHaveLength(0)
    })

    it('unpicks from the bar, one or all', async () => {
      renderScreen()
      await act(async () => {})
      fireEvent.click(selectButton())
      for (const box of boxes()) fireEvent.click(box)
      expect(screen.getByText('3 agents picked')).toBeInTheDocument()
      fireEvent.click(
        screen.getByRole('button', { name: 'Unpick Claude Code, api / t1' }),
      )
      expect(
        screen.getByRole('checkbox', { name: 'Pick Claude Code, api / t1' }),
      ).not.toBeChecked()
      expect(screen.getByText('2 agents picked')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Unpick all' }))
      expect(
        boxes().filter((b) => (b as HTMLInputElement).checked),
      ).toHaveLength(0)
      // Unchecking a card unpicks it too
      fireEvent.click(boxes()[0])
      fireEvent.click(boxes()[0])
      expect(screen.getByText('Pick the agents to send to')).toBeInTheDocument()
    })

    it('sends to each agent once, then again only to the one that failed', async () => {
      mockSendMessage.mockImplementation(async (pane: string) => {
        if (pane === 'p-old')
          throw new RequestError(503, 'agent_unavailable', '')
        return { queued: pane === 'p-blocked' }
      })
      renderScreen()
      await act(async () => {})
      fireEvent.click(selectButton())
      for (const box of boxes()) fireEvent.click(box)
      fireEvent.change(field(), { target: { value: 'pull main' } })
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Send' })),
      )
      expect(mockSendMessage.mock.calls.map((c) => c[0]).sort()).toEqual([
        'p-blocked',
        'p-idle',
        'p-old',
      ])
      expect(mockSendMessage).toHaveBeenCalledWith('p-idle', 'pull main', 'c')
      // Only the agent that failed stays picked, and the text stays
      expect(screen.getByText('1 agent picked')).toBeInTheDocument()
      expect(field()).toHaveValue('pull main')
      const picked = boxes().filter((b) => (b as HTMLInputElement).checked)
      expect(picked).toHaveLength(1)
      const outcomes = screen
        .getAllByRole('listitem')
        .map((li) => li.dataset.outcome)
        .filter(Boolean)
        .sort()
      expect(outcomes).toEqual(['failed', 'queued', 'sent'])

      mockSendMessage.mockReset()
      mockSendMessage.mockResolvedValue({ queued: false })
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Send' })),
      )
      expect(mockSendMessage.mock.calls).toEqual([['p-old', 'pull main', 'c']])
      expect(field()).toHaveValue('')
      expect(screen.getByText('Pick the agents to send to')).toBeInTheDocument()
    })

    it('unpicks an agent whose pane went', async () => {
      const { rerender, onOpen, onClose } = renderScreen()
      await act(async () => {})
      fireEvent.click(selectButton())
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Pick Claude Code, api / t1' }),
      )
      const props = {
        groups: GROUPS,
        groupNoun: 'workspace' as const,
        ready: true,
        pollInterval: 5000,
        clockOffset: 0,
        activePaneOnly: false,
        opensChat: (p: SessionPane) => p.agentName === 'claude',
        canAnswer: (p: SessionPane) => p.agentName === 'claude',
        readOnly: false,
        stuckMinutes: 10,
        onOpen,
        onClose,
      }
      rerender(<OverviewScreen {...props} sessions={SESSIONS.slice(1)} />)
      expect(screen.getByText('Pick the agents to send to')).toBeInTheDocument()
      // It does not come back picked under the same id
      rerender(<OverviewScreen {...props} sessions={SESSIONS} />)
      expect(
        screen.getByRole('checkbox', { name: 'Pick Claude Code, api / t1' }),
      ).not.toBeChecked()
    })
  })
})

describe('OverviewScreen, the Plan', () => {
  const job = (id: string, paneId: string, ref: string) => ({
    id,
    title: `job ${id}`,
    state: 'active',
    updated: 'u',
    agent: { key: paneId, paneId, kind: 'claude' },
    live: { status: 'working', paneId, ref },
  })

  beforeEach(() => {
    resetAgentOverview()
    resetActivityLog()
    resetJobs()
    mockFetchUsage.mockRejectedValue(new Error('no usage'))
    mockFetchActivity.mockRejectedValue(new Error('no activity'))
    mockFetchOverview.mockResolvedValue({ serverNow: '', panes: [] })
    mockFetchJobs.mockResolvedValue({
      jobs: [job('a', 'p-blocked', 'web:t3'), job('b', 'p-new', 'web:t2')],
      readOnly: false,
      canGrant: true,
      serverNow: '',
    })
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => {
    window.location.hash = ''
  })
  const openPlan = () =>
    fireEvent.click(screen.getByRole('tab', { name: /^Plan/ }))
  // Opens a job's details (a sheet: the test's screen is narrow)
  const pick = (title: string) =>
    fireEvent.click(
      within(screen.getByRole('article', { name: title })).getByRole('button'),
    )

  it('reads the jobs with the overview, in their own tab', async () => {
    renderScreen()
    await act(async () => {})
    expect(mockFetchJobs).toHaveBeenCalledTimes(1)
    // The title keeps the focus, on the agents
    expect(screen.getByRole('heading', { name: 'Agents' })).toHaveFocus()
    expect(screen.queryByRole('region', { name: 'Plan' })).toBeNull()
    openPlan()
    const plan = screen.getByRole('region', { name: 'Plan' })
    expect(within(plan).getAllByRole('article')).toHaveLength(2)
  })

  it("opens a job's pane as its card does", async () => {
    const { onOpen } = renderScreen()
    await act(async () => {})
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    openPlan()
    pick('job a')
    fireEvent.click(screen.getByRole('button', { name: 'Open pane web:t3' }))
    expect(onOpen).toHaveBeenLastCalledWith(
      SESSIONS[2],
      SESSIONS[2].panes![1],
      'chat',
    )
    pick('job b')
    fireEvent.click(screen.getByRole('button', { name: 'Open pane web:t2' }))
    expect(onOpen).toHaveBeenLastCalledWith(
      SESSIONS[1],
      SESSIONS[1].panes![0],
      'terminal',
    )
  })

  it("gives the Activity's room to a job's details on a wide screen, and back", async () => {
    const orig = window.matchMedia
    window.matchMedia = ((query: string) => ({
      ...orig(query),
      matches: query === '(min-width: 1280px)',
    })) as typeof window.matchMedia
    try {
      renderScreen()
      await act(async () => {})
      const activity = screen.getByRole('button', { name: 'Activity' })
      fireEvent.click(activity)
      expect(
        screen.getByRole('complementary', { name: 'Activity' }),
      ).toBeVisible()
      openPlan()
      pick('job a')
      const details = screen.getByRole('complementary', { name: 'job a' })
      expect(details).toBeVisible()
      expect(
        screen.queryByRole('complementary', { name: 'Activity' }),
      ).toBeNull()
      // Hidden on the Agents tab, and the same details back on the Plan tab
      // (not drawn again, so what is open in them stays)
      fireEvent.click(screen.getByRole('tab', { name: /^Agents/ }))
      // (the slot's class: jsdom has no Tailwind)
      expect(details.parentElement).toHaveClass('hidden')
      openPlan()
      expect(screen.getByRole('complementary', { name: 'job a' })).toBe(details)
      expect(details.parentElement).toHaveClass('contents')
      expect(activity).toHaveAttribute('aria-pressed', 'false')
      fireEvent.click(activity)
      expect(
        screen.getByRole('complementary', { name: 'Activity' }),
      ).toBeVisible()
      expect(screen.queryByRole('complementary', { name: 'job a' })).toBeNull()
    } finally {
      window.matchMedia = orig
    }
  })

  it('offers the agents to give a job to', async () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    renderScreen()
    await act(async () => {})
    openPlan()
    pick('job a')
    fireEvent.click(screen.getByRole('button', { name: 'Edit job a' }))
    const options = within(
      screen.getByRole('combobox', { name: 'Agent' }),
    ).getAllByRole('option')
    // In the cards' order, which the clock decides
    expect(options[0]).toHaveTextContent('Keep the agent it has')
    expect(
      options
        .slice(1)
        .map((o) => o.textContent)
        .sort(),
    ).toEqual([
      'Claude Code · api / t1',
      'Claude Code · web / t3',
      'Claude Code · web / t3',
      'Codex · web / t2',
    ])
  })

  it('brings the Plan into view when its address asks for it', async () => {
    window.location.hash = '#/overview?plan=1'
    renderScreen()
    await act(async () => {})
    expect(screen.getByRole('heading', { name: 'Plan' })).toHaveFocus()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('brings the Plan into view when asked while open', async () => {
    renderScreen()
    await act(async () => {})
    expect(screen.getByRole('heading', { name: 'Agents' })).toHaveFocus()
    act(() => {
      window.dispatchEvent(
        new HashChangeEvent('hashchange', {
          newURL: 'http://localhost/#/overview?plan=1',
        }),
      )
    })
    expect(screen.getByRole('heading', { name: 'Plan' })).toHaveFocus()
    // A synthetic event reads the address; one without the Plan is ignored
    screen.getByRole('heading', { name: 'Agents' }).focus()
    act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(screen.getByRole('heading', { name: 'Agents' })).toHaveFocus()
    window.location.hash = '#/overview?plan=1'
    act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(screen.getByRole('heading', { name: 'Plan' })).toHaveFocus()
  })
})

describe('OverviewScreen, the tabs', () => {
  const job = (id: string, status: string) => ({
    id,
    title: `job ${id}`,
    state: 'active',
    updated: 'u',
    live: { status },
  })
  const agentsTab = () => screen.getByRole('tab', { name: /^Agents/ })
  const planTab = () => screen.getByRole('tab', { name: /^Plan/ })

  beforeEach(async () => {
    // An address the test before set is announced late: let it pass first
    await act(() => new Promise((r) => setTimeout(r, 50)))
    resetAgentOverview()
    resetActivityLog()
    resetJobs()
    mockFetchUsage.mockRejectedValue(new Error('no usage'))
    mockFetchActivity.mockRejectedValue(new Error('no activity'))
    mockFetchOverview.mockResolvedValue({ serverNow: '', panes: [] })
    mockFetchJobs.mockResolvedValue({
      jobs: [job('a', 'blocked'), job('b', 'working'), job('c', 'idle')],
      readOnly: false,
      canGrant: true,
      serverNow: '',
    })
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => {
    window.location.hash = ''
    vi.restoreAllMocks()
  })

  it('counts the agents and the open jobs, and what waits for the user', async () => {
    renderScreen()
    await act(async () => {})
    expect(
      screen.getByRole('tablist', { name: 'Agent overview sections' }),
    ).toBeInTheDocument()
    expect(agentsTab()).toHaveAccessibleName('Agents, 4 agents, 1 needs you')
    expect(agentsTab()).toHaveTextContent('Agents · 41 needs you')
    expect(planTab()).toHaveAccessibleName('Plan, 3 open, 1 waiting')
    expect(agentsTab()).toHaveAttribute('aria-selected', 'true')
    const panel = document.getElementById(
      agentsTab().getAttribute('aria-controls')!,
    )!
    expect(panel).toHaveAttribute('role', 'tabpanel')
    expect(panel).toHaveAttribute('aria-labelledby', agentsTab().id)
  })

  it('counts the questions waiting on the Plan, and opens on it while they wait', async () => {
    mockFetchAsks.mockResolvedValue({
      asks: [
        { id: 'Q1', state: 'open', created: '' },
        { id: 'Q2', state: 'open', created: '' },
        { id: 'Q3', state: 'answered', created: '' },
      ],
      readOnly: true,
    })
    // The badge on the overview's button read them before it opened
    await reloadJobs()
    renderScreen()
    await act(async () => {})
    expect(planTab()).toHaveAccessibleName('Plan, 3 open, 3 waiting')
    expect(planTab()).toHaveAttribute('aria-selected', 'true')
    mockFetchAsks.mockReset()
  })

  it('opens on the tab this browser looked at last', async () => {
    const { unmount } = renderScreen()
    await act(async () => {})
    expect(agentsTab()).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(planTab())
    expect(localStorage.getItem('termote-overview-tab')).toBe('plan')
    unmount()
    renderScreen()
    await act(async () => {})
    expect(planTab()).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('region', { name: 'Plan' })).toBeInTheDocument()
  })

  it('opens on Agents for an odd saved tab, or without storage', async () => {
    localStorage.setItem('termote-overview-tab', 'jobs')
    const first = renderScreen()
    await act(async () => {})
    expect(agentsTab()).toHaveAttribute('aria-selected', 'true')
    first.unmount()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    renderScreen()
    await act(async () => {})
    expect(agentsTab()).toHaveAttribute('aria-selected', 'true')
    // Choosing still works, only forgotten
    fireEvent.click(planTab())
    expect(planTab()).toHaveAttribute('aria-selected', 'true')
  })

  it('opens the Plan the address asks for once, the tab keeping the focus after', async () => {
    window.location.hash = '#/overview?plan=1'
    renderScreen()
    await act(async () => {})
    expect(planTab()).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'Plan' })).toHaveFocus()
    act(() => planTab().focus())
    fireEvent.keyDown(planTab(), { key: 'ArrowLeft' })
    expect(agentsTab()).toHaveFocus()
    expect(agentsTab()).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(agentsTab(), { key: 'ArrowRight' })
    expect(planTab()).toHaveFocus()
    expect(planTab()).toHaveAttribute('aria-selected', 'true')
    // The arrows are the user's choice, saved
    expect(localStorage.getItem('termote-overview-tab')).toBe('plan')
  })

  it('moves with Home, End and the arrows wrapping round', async () => {
    renderScreen()
    await act(async () => {})
    act(() => agentsTab().focus())
    fireEvent.keyDown(agentsTab(), { key: 'End' })
    expect(planTab()).toHaveFocus()
    fireEvent.keyDown(planTab(), { key: 'ArrowRight' })
    expect(agentsTab()).toHaveFocus()
    fireEvent.keyDown(agentsTab(), { key: 'ArrowLeft' })
    expect(planTab()).toHaveFocus()
    fireEvent.keyDown(planTab(), { key: 'Home' })
    expect(agentsTab()).toHaveFocus()
    // Another key does nothing
    fireEvent.keyDown(agentsTab(), { key: 'a' })
    expect(agentsTab()).toHaveAttribute('aria-selected', 'true')
    expect(planTab()).toHaveAttribute('tabindex', '-1')
  })

  it('has no tabs without a job ledger, even when the address asks for the Plan', async () => {
    window.location.hash = '#/overview?plan=1'
    localStorage.setItem('termote-overview-tab', 'plan')
    mockFetchJobs.mockRejectedValue(
      new RequestError(404, 'jobs_unavailable', ''),
    )
    renderScreen()
    await act(async () => {})
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(cardNames()).toHaveLength(4)
    // Not saved over
    expect(localStorage.getItem('termote-overview-tab')).toBe('plan')
  })

  it('brings Agents back for a card asked for on the Plan, and focuses it', async () => {
    const props = {
      sessions: SESSIONS,
      groups: GROUPS,
      groupNoun: 'workspace',
      ready: true,
      pollInterval: 5000,
      clockOffset: 0,
      activePaneOnly: false,
      opensChat: (p: SessionPane) => p.agentName === 'claude',
      canAnswer: (p: SessionPane) => p.agentName === 'claude',
      readOnly: false,
      stuckMinutes: 10,
      onOpen: vi.fn(),
      onClose: vi.fn(),
    }
    const { rerender } = render(<OverviewScreen {...props} />)
    await act(async () => {})
    fireEvent.click(planTab())
    // The focus on the Plan's tab, not the title
    act(() => planTab().focus())
    rerender(<OverviewScreen {...props} focusPane={{ paneId: 'p-new' }} />)
    expect(agentsTab()).toHaveAttribute('aria-selected', 'true')
    expect(
      screen.getByRole('button', { name: /^Open terminal: Codex,/ }),
    ).toHaveFocus()
    // Asked again with nothing focused
    act(() => (document.activeElement as HTMLElement).blur())
    expect(document.activeElement).toBe(document.body)
    rerender(<OverviewScreen {...props} focusPane={{ paneId: 'p-old' }} />)
    expect(
      screen.getByRole('button', {
        name: /^Open chat: Claude Code, Working, web \/ t3/,
      }),
    ).toHaveFocus()
    // No card asked for any more: the tab stays as it is
    fireEvent.click(planTab())
    rerender(<OverviewScreen {...props} />)
    expect(planTab()).toHaveAttribute('aria-selected', 'true')
  })

  it('lets a card asked for on the Plan take the focus once, not when it shows later', async () => {
    const props = {
      sessions: SESSIONS,
      groups: GROUPS,
      groupNoun: 'workspace',
      ready: true,
      pollInterval: 5000,
      clockOffset: 0,
      activePaneOnly: false,
      opensChat: (p: SessionPane) => p.agentName === 'claude',
      canAnswer: (p: SessionPane) => p.agentName === 'claude',
      readOnly: false,
      stuckMinutes: 10,
      onOpen: vi.fn(),
      onClose: vi.fn(),
    }
    const { rerender } = render(<OverviewScreen {...props} />)
    await act(async () => {})
    // The working agent filtered out, then the Plan
    fireEvent.click(screen.getByRole('radio', { name: 'Needs you, 1 agent' }))
    fireEvent.click(planTab())
    act(() => planTab().focus())
    rerender(<OverviewScreen {...props} focusPane={{ paneId: 'p-new' }} />)
    expect(agentsTab()).toHaveAttribute('aria-selected', 'true')
    // The user moves on, then shows every agent: the card takes nothing
    const all = screen.getByRole('radio', { name: 'All agents' })
    act(() => all.focus())
    fireEvent.click(all)
    expect(
      screen.getByRole('button', { name: /^Open terminal: Codex,/ }),
    ).not.toHaveFocus()
    expect(all).toHaveFocus()
  })

  it('stops picking agents when the address opens the Plan', async () => {
    renderScreen()
    await act(async () => {})
    fireEvent.click(
      screen.getByRole('button', { name: 'Send a message to several agents' }),
    )
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Pick Claude Code, api / t1' }),
    )
    act(() => {
      window.dispatchEvent(
        new HashChangeEvent('hashchange', {
          newURL: 'http://localhost/#/overview?plan=1',
        }),
      )
    })
    expect(planTab()).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(agentsTab())
    expect(screen.queryByText('1 agent picked')).toBeNull()
    expect(
      screen.queryByRole('checkbox', { name: 'Pick Claude Code, api / t1' }),
    ).toBeNull()
  })

  it('shows no tabs before the ledger was read', async () => {
    localStorage.setItem('termote-overview-tab', 'plan')
    let answer: (v: unknown) => void = () => {}
    mockFetchJobs.mockReturnValue(new Promise((r) => (answer = r)))
    renderScreen()
    await act(async () => {})
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(cardNames()).toHaveLength(4)
    await act(async () =>
      answer({ jobs: [], readOnly: false, canGrant: false, serverNow: '' }),
    )
    expect(planTab()).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps an open History and a skipped dialog across a switch', async () => {
    renderScreen()
    await act(async () => {})
    fireEvent.click(screen.getAllByRole('button', { name: 'History' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(
      screen.getByText('1 skipped dialog is still waiting.'),
    ).toBeInTheDocument()
    fireEvent.click(planTab())
    expect(screen.queryByRole('button', { name: 'Hide history' })).toBeNull()
    fireEvent.click(agentsTab())
    expect(
      screen.getAllByRole('button', { name: 'Hide history' }),
    ).toHaveLength(1)
    expect(
      screen.getByText('1 skipped dialog is still waiting.'),
    ).toBeInTheDocument()
  })

  it('stops picking agents on the Plan, and hides the search there', async () => {
    renderScreen()
    await act(async () => {})
    const select = () =>
      screen.queryByRole('button', { name: 'Send a message to several agents' })
    fireEvent.click(select()!)
    expect(screen.getByText('Pick the agents to send to')).toBeInTheDocument()
    fireEvent.click(planTab())
    expect(screen.queryByText('Pick the agents to send to')).toBeNull()
    expect(select()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Search agents' })).toBeNull()
    fireEvent.click(agentsTab())
    expect(select()).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('OverviewScreen, the Agents sections', () => {
  beforeEach(() => {
    resetAgentOverview()
    resetActivityLog()
    resetJobs()
    mockFetchUsage.mockRejectedValue(new Error('no usage'))
    mockFetchActivity.mockRejectedValue(new Error('no activity'))
    mockFetchOverview.mockResolvedValue({ serverNow: '', panes: [] })
    mockFetchJobs.mockResolvedValue({
      jobs: [],
      readOnly: false,
      canGrant: false,
      serverNow: '',
    })
  })
  const heads = () =>
    [...document.querySelectorAll('li:not([data-card]) > h3')].map(
      (h) => h.textContent,
    )
  const props = {
    groups: GROUPS,
    groupNoun: 'workspace',
    ready: true,
    pollInterval: 5000,
    clockOffset: 0,
    activePaneOnly: false,
    opensChat: (p: SessionPane) => p.agentName === 'claude',
    canAnswer: (p: SessionPane) => p.agentName === 'claude',
    readOnly: false,
    stuckMinutes: 10,
    onOpen: vi.fn(),
    onClose: vi.fn(),
  }
  const withStatus = (id: string, status: SessionPane['agentStatus']) =>
    SESSIONS.map((s) => ({
      ...s,
      panes: s.panes?.map((p) =>
        p.id === id ? { ...p, agentStatus: status } : p,
      ),
    }))

  it('names each section with its count, the dialogs first', async () => {
    renderScreen()
    await act(async () => {})
    expect(
      screen.getByRole('heading', { name: 'Needs you · 1' }),
    ).toBeInTheDocument()
    expect(heads()).toEqual(['Working · 2', 'Idle · 1'])
    // The blocked card first, under the dialogs, then each section's
    expect(cardNames()).toEqual([
      expect.stringMatching(/^Open chat: Claude Code, Needs you, web \/ t3/),
      expect.stringMatching(/^Open terminal: Codex, Working/),
      expect.stringMatching(/^Open chat: Claude Code, Working/),
      expect.stringMatching(/^Open chat: Claude Code, Idle/),
    ])
    // The filter says its words
    expect(
      screen.getByRole('radio', { name: 'Needs you, 1 agent' }),
    ).toHaveTextContent('Needs you · 1')
  })

  it('keeps a card, its History open and its focus, when it moves to another section', async () => {
    const { rerender } = render(
      <OverviewScreen {...props} sessions={SESSIONS} />,
    )
    await act(async () => {})
    const card = screen.getByRole('button', { name: /^Open terminal: Codex/ })
    const frame = card.closest('[data-status]') as HTMLElement
    fireEvent.click(within(frame).getByRole('button', { name: 'History' }))
    act(() => card.focus())
    rerender(
      <OverviewScreen {...props} sessions={withStatus('p-new', 'done')} />,
    )
    expect(heads()).toEqual(['Working · 1', 'Done · 1', 'Idle · 1'])
    expect(card).toBeInTheDocument()
    expect(card).toHaveFocus()
    expect(
      within(frame).getByRole('button', { name: 'Hide history' }),
    ).toBeInTheDocument()
    rerender(
      <OverviewScreen {...props} sessions={withStatus('p-new', 'blocked')} />,
    )
    expect(card).toHaveFocus()
    expect(
      within(frame).getByRole('button', { name: 'Hide history' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Needs you · 2' }),
    ).toBeInTheDocument()
  })

  it('shows the dialogs whatever the filter or the search hides', async () => {
    renderScreen()
    await act(async () => {})
    fireEvent.click(screen.getByRole('radio', { name: 'Working, 2 agents' }))
    expect(
      screen.getByRole('heading', { name: 'Needs you · 1' }),
    ).toBeInTheDocument()
    expect(heads()).toEqual(['Working · 2'])
    // Nothing matches: the dialogs stay above "No agents match"
    fireEvent.click(screen.getByRole('button', { name: 'Search agents' }))
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText('No agents match')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Needs you · 1' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: /^Needs you: Claude Code, web \/ t3/,
      }),
    ).toBeInTheDocument()
  })

  it("ArrowDown from the search focuses the first card, never a dialog's button", async () => {
    renderScreen()
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Search agents' }))
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'ArrowDown' })
    expect(
      screen.getByRole('button', {
        name: /^Open chat: Claude Code, Needs you, web \/ t3/,
      }),
    ).toHaveFocus()
  })

  it('names the job a pane works on in its card', async () => {
    mockFetchJobs.mockResolvedValue({
      jobs: [
        {
          id: 'a',
          title: 'Fix the login',
          state: 'active',
          updated: '2026-11-23T09:00:00Z',
          live: { status: 'working', paneId: 'p-new' },
        },
        {
          id: 'b',
          title: 'Gone job',
          state: 'active',
          updated: '2026-11-23T09:00:00Z',
          live: { status: 'gone', paneId: 'p-old' },
        },
      ],
      readOnly: false,
      canGrant: false,
      serverNow: '',
    })
    renderScreen()
    await act(async () => {})
    expect(
      screen.getByRole('button', { name: /^Open terminal: Codex/ }),
    ).toHaveAccessibleDescription(/^Job · Fix the login/)
    expect(
      screen.getByRole('button', { name: /^Open chat: Claude Code, Working/ }),
    ).not.toHaveAccessibleDescription(/Job/)
  })

  describe('OverviewScreen on a phone', () => {
    beforeEach(() => {
      resetAgentOverview()
      resetActivityLog()
      resetJobs()
      mockFetchUsage.mockRejectedValue(new Error('no usage'))
      mockFetchActivity.mockRejectedValue(new Error('no activity'))
      mockFetchOverview.mockResolvedValue({ serverNow: '', panes: [] })
      mockFetchJobs.mockResolvedValue({
        jobs: [],
        readOnly: false,
        canGrant: false,
        serverNow: '',
      })
      HTMLDialogElement.prototype.showModal = vi.fn(function (
        this: HTMLDialogElement,
      ) {
        this.setAttribute('open', '')
      })
      HTMLDialogElement.prototype.close = vi.fn()
    })

    it('puts picking and the activity log in a More menu', async () => {
      const orig = window.matchMedia
      window.matchMedia = ((query: string) => ({
        ...orig(query),
        matches: query === '(max-width: 767px)',
      })) as typeof window.matchMedia
      try {
        renderScreen()
        await act(async () => {})
        expect(
          screen.queryByRole('button', {
            name: 'Send a message to several agents',
          }),
        ).toBeNull()
        expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull()
        const more = screen.getByRole('button', {
          name: 'More overview actions',
        })
        fireEvent.click(more)
        const pick = screen.getByRole('menuitemcheckbox', {
          name: 'Send a message to several agents',
        })
        expect(pick).toHaveAttribute('aria-checked', 'false')
        fireEvent.click(pick)
        expect(
          screen.getByText('Pick the agents to send to'),
        ).toBeInTheDocument()
        fireEvent.click(more)
        expect(
          screen.getByRole('menuitemcheckbox', {
            name: 'Send a message to several agents',
          }),
        ).toHaveAttribute('aria-checked', 'true')
        fireEvent.click(
          screen.getByRole('menuitemcheckbox', {
            name: 'Send a message to several agents',
          }),
        )
        expect(screen.queryByText('Pick the agents to send to')).toBeNull()
        // The activity log opens as a sheet
        fireEvent.click(more)
        fireEvent.click(
          screen.getByRole('menuitemcheckbox', { name: 'Activity' }),
        )
        expect(screen.getByRole('dialog', { name: 'Activity' })).toBeVisible()
        // On the Plan the menu holds the activity log alone
        fireEvent.click(
          screen.getByRole('button', { name: 'Close the activity' }),
        )
        fireEvent.click(screen.getByRole('tab', { name: /^Plan/ }))
        fireEvent.click(more)
        expect(screen.getAllByRole('menuitemcheckbox')).toHaveLength(1)
      } finally {
        window.matchMedia = orig
      }
    })
  })
})
