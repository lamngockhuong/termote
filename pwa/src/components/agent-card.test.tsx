import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
    expect(screen.getByRole('button')).toHaveTextContent('0 changed')
    expect(screen.getByTitle(/first saw it/)).toHaveTextContent('≥ 5 min ago')
    expect(screen.getByRole('button')).toHaveAccessibleName(
      /^Open terminal: Agent,/,
    )
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
