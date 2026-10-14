import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from '../hooks/use-mux-api'
import type { Session, SessionGroup } from '../types/session'
import { ActivityLog, eventTime } from './activity-log'

const ev = (
  seq: number,
  key: string,
  from: string,
  to: string,
  agent = 'claude',
): ActivityEvent => ({
  seq,
  ts: `2026-10-13T10:0${seq}:00Z`,
  key,
  groupId: 'g1',
  tabId: '1',
  paneId: '1',
  agent,
  from,
  to,
})

// tmux: window 2 (key @7) was window 1 when its events were recorded.
const SESSIONS: Session[] = [
  {
    id: '2',
    key: '@7',
    name: 'build',
    icon: '',
    description: '',
    groupId: 'g1',
    panes: [{ id: '2', label: 'claude', hasAgent: true, agentName: 'claude' }],
  },
]
const GROUPS: SessionGroup[] = [{ id: 'g1', name: 'api' }]

function renderLog(over: Partial<Parameters<typeof ActivityLog>[0]> = {}) {
  const onOpen = vi.fn()
  render(
    <ActivityLog
      events={[
        ev(1, '@7', '', 'working'),
        ev(2, '@9', '', 'blocked', 'aider'),
        ev(3, '@7', 'working', 'blocked'),
        ev(4, '@7', 'blocked', ''),
      ]}
      sessions={SESSIONS}
      groups={GROUPS}
      clockOffset={0}
      loaded
      error={false}
      onOpen={onOpen}
      {...over}
    />,
  )
  return { onOpen }
}

const rows = () =>
  within(screen.getByRole('list', { name: 'Status changes' })).getAllByRole(
    'listitem',
  )

describe('ActivityLog', () => {
  it('lists the newest first and opens a pane by its key, under its current id', () => {
    const { onOpen } = renderLog()
    const r = rows()
    expect(r).toHaveLength(4)
    expect(r[0]).toHaveTextContent('Claude Code')
    expect(r[0]).toHaveTextContent('build')
    expect(r[0]).toHaveTextContent('needs you')
    expect(r[0]).toHaveTextContent('gone')
    fireEvent.click(within(r[0]).getByRole('button'))
    expect(onOpen).toHaveBeenCalledWith(SESSIONS[0], SESSIONS[0].panes![0])
    // A pane that has gone cannot be opened.
    expect(within(r[2]).queryByRole('button')).toBeNull()
    expect(r[2]).toHaveTextContent('closed')
    expect(r[2]).toHaveTextContent('aider')
  })

  it('filters by the status changed to', () => {
    renderLog()
    fireEvent.click(screen.getByRole('radio', { name: 'Needs you' }))
    expect(rows()).toHaveLength(2)
    fireEvent.click(screen.getByRole('radio', { name: 'Done' }))
    expect(screen.getByText('No changes match.')).toBeInTheDocument()
  })

  it('names the group when there are several', () => {
    renderLog({ groups: [...GROUPS, { id: 'g2', name: 'web' }] })
    expect(rows()[0]).toHaveTextContent('api / build')
  })

  it('shows an unnamed agent, an unknown status and a group it cannot name', () => {
    renderLog({
      events: [ev(1, '@7', 'mystery', 'working', '')],
      groups: [
        { id: 'g9', name: 'other' },
        { id: 'g8', name: 'more' },
      ],
    })
    expect(rows()[0]).toHaveTextContent('Agent')
    expect(rows()[0]).toHaveTextContent('mystery')
    expect(rows()[0]).toHaveTextContent('g1 / build')
  })

  it('says when there is nothing yet, or the read failed', () => {
    renderLog({ events: [], error: true })
    expect(
      screen.getByText('No status changes since the server started.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/retrying/)
  })

  it("shows a server time on this device's clock", () => {
    const at = '2026-10-13T10:00:30Z'
    const local = new Date(Date.parse(at) - 30_000).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    expect(eventTime(at, 30_000)).toBe(local)
    expect(eventTime('nope', 0)).toBe('')
  })
})
