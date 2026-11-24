import { act, fireEvent, render, screen } from '@testing-library/react'
import { MessageSquare, Terminal } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetJobs } from '../hooks/use-jobs'
import type { Ask } from '../hooks/use-mux-api'
import { OverviewButton } from './overview-button'
import { ViewMenu } from './ui/view-menu'

const api = vi.hoisted(() => ({ fetchAsks: vi.fn() }))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchAsks: () => api.fetchAsks(),
}))

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id,
  state: 'open',
  created: '2026-11-24T09:55:00Z',
  ...over,
})

const read = async (asks: Ask[], readOnly = false) => {
  api.fetchAsks.mockResolvedValue({ asks, readOnly })
}

const settle = () => act(async () => {})

describe('OverviewButton', () => {
  beforeEach(() => {
    resetJobs()
    api.fetchAsks.mockReset()
  })
  afterEach(() => resetJobs())

  it('has no badge while no question waits', async () => {
    await read([ask('Q1', { state: 'answered' })])
    const onClick = vi.fn()
    render(<OverviewButton onClick={onClick} pressed={false} />)
    await settle()
    const button = screen.getByRole('button', { name: 'Agent overview' })
    expect(button).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByTestId('asks-count')).toBeNull()
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('counts the open questions in its corner and in its name', async () => {
    await read([ask('Q1'), ask('Q2'), ask('Q3', { state: 'answered' })])
    render(<OverviewButton onClick={() => {}} pressed />)
    await settle()
    const button = screen.getByRole('button', {
      name: 'Agent overview, 2 questions waiting for you',
    })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('asks-count')).toHaveTextContent('2')
  })

  it('counts them on a view-only device too, and caps the badge at 9+', async () => {
    await read(
      Array.from({ length: 12 }, (_, i) => ask(`Q${i}`)),
      true,
    )
    render(<OverviewButton onClick={() => {}} pressed={false} />)
    await settle()
    expect(
      screen.getByRole('button', {
        name: 'Agent overview, 12 questions waiting for you',
      }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('asks-count')).toHaveTextContent('9+')
  })

  it('says one question in the singular', async () => {
    await read([ask('Q1')])
    render(<OverviewButton onClick={() => {}} pressed={false} />)
    await settle()
    expect(
      screen.getByRole('button', {
        name: 'Agent overview, 1 question waiting for you',
      }),
    ).toBeInTheDocument()
  })
})

describe('ViewMenu', () => {
  beforeEach(() => {
    resetJobs()
    api.fetchAsks.mockReset()
  })
  afterEach(() => resetJobs())

  const views = [
    { id: 'terminal', label: 'Terminal', Icon: Terminal },
    { id: 'chat', label: 'Chat', Icon: MessageSquare },
  ]

  it('marks its trigger and the overview entry while questions wait', async () => {
    await read([ask('Q1'), ask('Q2')])
    render(
      <ViewMenu
        views={views}
        value="terminal"
        onChange={() => {}}
        onOpenOverview={() => {}}
      />,
    )
    await settle()
    expect(screen.getByTestId('asks-dot')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Terminal/ }))
    const item = await screen.findByRole('menuitem', {
      name: /Agent overview/,
    })
    expect(item).toHaveTextContent('2 questions waiting for you')
  })

  it('reads no asks without the overview, and marks nothing while none wait', async () => {
    await read([])
    const { unmount } = render(
      <ViewMenu views={views} value="terminal" onChange={() => {}} />,
    )
    await settle()
    expect(api.fetchAsks).not.toHaveBeenCalled()
    unmount()
    render(
      <ViewMenu
        views={views}
        value="terminal"
        onChange={() => {}}
        onOpenOverview={() => {}}
      />,
    )
    await settle()
    expect(api.fetchAsks).toHaveBeenCalled()
    expect(screen.queryByTestId('asks-dot')).toBeNull()
  })
})
