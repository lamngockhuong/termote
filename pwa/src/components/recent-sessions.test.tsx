import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistorySession } from '../hooks/use-mux-api'
import { RECENT_SESSIONS, RecentSessions } from './recent-sessions'

const session = (id: string, extra: Partial<HistorySession> = {}) =>
  ({
    agent: 'claude',
    id,
    title: `Title ${id}`,
    titleSource: 'ai',
    cwd: '',
    updatedAt: new Date().toISOString(),
    ...extra,
  }) as HistorySession

let sessions: HistorySession[]

beforeEach(() => {
  sessions = []
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ sessions, truncated: false }), {
          status: 200,
        }),
    ),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('RecentSessions', () => {
  it('offers the latest sessions not running, to open or resume', async () => {
    sessions = [
      session('live', { live: { tabId: 't', paneId: 'p' } }),
      session('a'),
      session('b', { agent: 'codex' }),
      session('c'),
      session('d'),
    ]
    const onResume = vi.fn()
    const onOpen = vi.fn()
    render(
      <RecentSessions
        paneId="p1"
        where="here"
        onResume={onResume}
        onOpen={onOpen}
      />,
    )
    await screen.findByText('Title a')
    expect(screen.queryByText('Title live')).toBeNull()
    expect(screen.queryByText('Title d')).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(RECENT_SESSIONS)
    fireEvent.click(screen.getByText('Title b'))
    expect(onOpen).toHaveBeenCalledWith(sessions[2])
    fireEvent.click(screen.getByRole('button', { name: 'See all' }))
    expect(onOpen).toHaveBeenLastCalledWith()
    fireEvent.click(screen.getAllByRole('button', { name: 'Resume' })[0])
    expect(onResume).toHaveBeenCalledWith(sessions[1], 'here')
  })

  it('shows a resume in progress, and only reading without a way to resume', async () => {
    sessions = [session('a'), session('b')]
    const { rerender } = render(
      <RecentSessions
        paneId="p1"
        where="tab"
        pending="a"
        onResume={vi.fn()}
        onOpen={vi.fn()}
      />,
    )
    await screen.findByText('Resuming…')
    expect(
      (screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    rerender(<RecentSessions paneId="p1" onResume={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  })

  it('shows nothing without sessions', async () => {
    const { container } = render(
      <RecentSessions paneId="p1" onResume={vi.fn()} onOpen={vi.fn()} />,
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
  })
})
