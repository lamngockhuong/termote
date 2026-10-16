import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const { mockFetchSubagents } = vi.hoisted(() => ({
  mockFetchSubagents: vi.fn(),
}))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchSubagents: (id: string) => mockFetchSubagents(id),
}))

import type { Session, SessionPane } from '../types/session'
import { AgentCard, formatTokens, statusAge } from './agent-card'

const NOW = Date.parse('2026-10-13T09:10:00Z')
const SESSION: Session = { id: 't', name: 'build', icon: '', description: '' }
const pane = (over: Partial<SessionPane> = {}): SessionPane => ({
  id: 'w1:p1',
  label: 'claude',
  hasAgent: true,
  agentName: 'claude',
  agentStatus: 'blocked',
  agentSince: '2026-10-13T09:05:00Z',
  ...over,
})

function renderCard(props: Partial<Parameters<typeof AgentCard>[0]> = {}) {
  const onOpen = vi.fn()
  const utils = render(
    <AgentCard
      session={SESSION}
      pane={pane()}
      where="api / build"
      now={NOW}
      paneKey="w1:p1"
      events={[]}
      opensChat
      onOpen={onOpen}
      {...props}
    />,
  )
  return { ...utils, onOpen }
}

describe('formatTokens', () => {
  it('fits the count in a few characters', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(12_345)).toBe('12k')
    expect(formatTokens(1_234)).toBe('1.2k')
    expect(formatTokens(184_400)).toBe('184k')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })
})

describe('statusAge', () => {
  it('says how long, marked when the server first saw it so', () => {
    expect(statusAge('2026-10-13T09:05:00Z', false, NOW)).toBe('5 min ago')
    expect(statusAge('2026-10-13T09:05:00Z', true, NOW)).toBe('≥ 5 min ago')
    expect(statusAge('2026-10-13T09:09:50Z', true, NOW)).toBe('just now')
    expect(statusAge(undefined, false, NOW)).toBeUndefined()
    expect(statusAge('nope', false, NOW)).toBeUndefined()
  })
})

describe('AgentCard', () => {
  it('shows how full the context is, ~ when the window is assumed', () => {
    const usage = {
      contextTokens: 144_000,
      contextWindow: 200_000,
      contextPercent: 72,
      model: 'claude-model',
    }
    const { rerender } = renderCard({
      overview: {
        paneId: 'w1:p1',
        key: 'w1:p1',
        usage: { ...usage, exact: true },
      },
    })
    const open = screen.getByRole('button', { name: /^Open chat/ })
    expect(open).toHaveTextContent('72%144k/200k· claude-model')
    expect(screen.getByText('72%')).toHaveClass('text-warning')
    expect(screen.getByText('72%')).not.toHaveAttribute('title')
    expect(
      screen.getByRole('meter', { hidden: true, name: 'Context' }),
    ).toHaveAttribute('aria-valuetext', '72%, 144k of 200k tokens')
    rerender(
      <AgentCard
        session={SESSION}
        pane={pane()}
        where="build"
        now={NOW}
        paneKey="w1:p1"
        events={[]}
        opensChat
        onOpen={vi.fn()}
        overview={{
          paneId: 'w1:p1',
          key: 'w1:p1',
          usage: {
            contextTokens: 190_000,
            contextWindow: 200_000,
            contextPercent: 95,
            exact: false,
          },
        }}
      />,
    )
    expect(screen.getByText('~95%')).toHaveClass('text-danger')
    expect(screen.getByText('~95%')).toHaveAttribute(
      'title',
      'Window assumed: the agent was not started with --model',
    )
    expect(open).not.toHaveTextContent('claude-model')
  })

  it('shows the hidden characters of the last words', () => {
    renderCard({
      overview: {
        paneId: 'w1:p1',
        key: 'w1:p1',
        lastText: 'run \u202egnp.exe\u061c',
      },
    })
    expect(screen.getByText('run ⟨U+202E⟩gnp.exe⟨U+061C⟩')).toBeInTheDocument()
  })

  it('shows the status, place, last words, changes and context', () => {
    const { onOpen } = renderCard({
      worktree: true,
      groupTitle: 'workspace api',
      overview: {
        paneId: 'w1:p1',
        key: 'w1:p1',
        lastText: 'Shall I run the tests?',
        branch: 'feat/x',
        changed: 3,
        changedTruncated: true,
        usage: { contextTokens: 48_200, model: 'claude-model' },
      },
    })
    const open = screen.getByRole('button', {
      name: 'Open chat: Claude Code, Needs you, api / build',
    })
    expect(open).toHaveTextContent('Needs you · 5 min ago')
    expect(open).toHaveTextContent('worktree')
    expect(open).toHaveTextContent('feat/x· 3+ changed')
    expect(open).toHaveTextContent('48k tokens· claude-model')
    // The details are read after the name
    expect(open).toHaveAccessibleDescription(/Shall I run the tests\?/)
    expect(screen.getByTitle('workspace api')).toHaveTextContent('api / build')
    fireEvent.click(open)
    expect(onOpen).toHaveBeenLastCalledWith(
      SESSION,
      expect.objectContaining({ id: 'w1:p1' }),
      'chat',
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open terminal: Claude Code, api / build',
      }),
    )
    expect(onOpen).toHaveBeenLastCalledWith(
      SESSION,
      expect.anything(),
      'terminal',
    )
  })

  it('shows a placeholder until the summary is read, none when it failed', () => {
    const { container, rerender } = renderCard({ opensChat: false })
    expect(container.querySelector('[class*="animate-pulse"]')).not.toBeNull()
    expect(
      screen.queryByRole('button', {
        name: /^Open terminal: Claude Code, api/,
      }),
    ).toBeNull()
    rerender(
      <AgentCard
        session={SESSION}
        pane={pane()}
        where="w"
        now={NOW}
        paneKey="w1:p1"
        events={[]}
        opensChat={false}
        overviewFailed
        onOpen={() => {}}
      />,
    )
    expect(container.querySelector('[class*="animate-pulse"]')).toBeNull()
  })

  it('hides what could not be read and names an unknown agent', () => {
    renderCard({
      pane: pane({
        agentName: 'aider',
        agentStatus: undefined,
        agentSince: undefined,
      }),
      overview: {
        paneId: 'w1:p1',
        key: 'w1:p1',
        changed: 2,
        unavailable: ['changes'],
      },
    })
    const open = screen.getByRole('button', {
      name: 'Open chat: aider, status unknown, api / build',
    })
    expect(open).not.toHaveTextContent('changed')
    expect(open).not.toHaveTextContent('tokens')
  })

  it('a card read without text shows no placeholder', () => {
    const { container } = renderCard({
      pane: pane({ agentName: undefined, agentSinceFirstSeen: true }),
      opensChat: false,
      overview: { paneId: 'w1:p1', key: 'w1:p1', branch: '', changed: 0 },
    })
    expect(container.querySelector('[class*="animate-pulse"]')).toBeNull()
    const open = screen.getByRole('button', { name: /^Open terminal: Agent,/ })
    expect(open).toHaveTextContent('0 changed')
    expect(screen.getByTitle(/first saw it/)).toHaveTextContent('≥ 5 min ago')
  })

  it('marks an agent that may be stuck, not by colour alone', () => {
    const { container } = renderCard({
      pane: pane({ agentStatus: 'working' }),
      stuckFor: 14,
    })
    expect(container.firstChild).toHaveAttribute('data-stuck', 'true')
    expect(
      screen.getByRole('button', { name: /^Open chat/ }),
    ).toHaveAccessibleDescription(/May be stuck: no new activity for 14 min/)
  })
})

describe('AgentCard history', () => {
  it('opens on the strip and, for Claude, the subagent tree', async () => {
    mockFetchSubagents.mockResolvedValue({
      nodes: [
        {
          id: 'a1',
          type: 'Explore',
          status: 'running',
          depth: 1,
          children: [],
        },
      ],
    })
    renderCard({
      events: [
        {
          seq: 1,
          ts: '2026-10-13T09:05:00Z',
          key: 'w1:p1',
          groupId: 'w1',
          tabId: 'w1:t1',
          paneId: 'w1:p1',
          agent: 'claude',
          from: '',
          to: 'blocked',
        },
      ],
    })
    const toggle = screen.getByRole('button', { name: 'History' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(mockFetchSubagents).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(toggle))
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByRole('img', { name: 'Last 60 min: needs you 5 min' }),
    ).toBeInTheDocument()
    expect(mockFetchSubagents).toHaveBeenCalledWith('w1:p1')
    expect(screen.getByRole('list', { name: 'Subagents' })).toBeInTheDocument()
    // Closed again, it still counts the subagents it read.
    await act(async () => fireEvent.click(toggle))
    expect(
      screen.getByRole('button', { name: 'History · 1 subagent, 1 running' }),
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Subagents' })).toBeNull()
  })

  it('has no subagent tree for another agent', async () => {
    mockFetchSubagents.mockClear()
    renderCard({ pane: pane({ id: 'w1:p9', agentName: 'codex' }) })
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'History' })),
    )
    expect(mockFetchSubagents).not.toHaveBeenCalled()
    expect(screen.queryByRole('list', { name: 'Subagents' })).toBeNull()
    expect(screen.getByText('No data yet')).toBeInTheDocument()
  })
})
