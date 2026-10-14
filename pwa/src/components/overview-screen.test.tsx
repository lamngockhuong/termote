import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionGroup } from '../types/session'

const { mockFetchOverview } = vi.hoisted(() => ({ mockFetchOverview: vi.fn() }))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchOverview: () => mockFetchOverview(),
}))

import { resetAgentOverview } from '../hooks/use-agent-overview'
import { agentCards, OVERVIEW_TICK, OverviewScreen } from './overview-screen'

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
  within(screen.getByRole('list'))
    .getAllByRole('button', { name: /^Open (chat|terminal): [^,]+, [^,]+, / })
    .map((b) => b.getAttribute('aria-label'))

describe('OverviewScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(NOW)
    resetAgentOverview()
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

  it('lists every agent, the ones waiting on the user first', async () => {
    renderScreen()
    await act(async () => {})
    expect(cardNames()).toEqual([
      'Open chat: Claude Code, Needs you, web / t3',
      'Open chat: Claude Code, Working, web / t3',
      'Open terminal: Codex, Working, web / t2',
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

  it('says when no agent matches, and shows all again', () => {
    renderScreen({ sessions: [SESSIONS[0]] })
    fireEvent.click(screen.getByRole('radio', { name: 'Needs you, 0 agents' }))
    expect(screen.getByText('No agents match')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }))
    expect(cardNames()).toHaveLength(1)
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
    expect(screen.getByRole('list')).toHaveTextContent('3 min ago')
    await act(async () => {
      vi.advanceTimersByTime(OVERVIEW_TICK * 2)
    })
    expect(screen.getByRole('list')).toHaveTextContent('4 min ago')
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
})
