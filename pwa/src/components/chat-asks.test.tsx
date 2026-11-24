import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetJobs } from '../hooks/use-jobs'
import type { Ask } from '../hooks/use-mux-api'
import { ChatAsks } from './chat-asks'

const api = vi.hoisted(() => ({ fetchAsks: vi.fn(), answerAsk: vi.fn() }))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchAsks: () => api.fetchAsks(),
  answerAsk: (id: string, a: unknown) => api.answerAsk(id, a),
}))

const ask = (id: string, over: Partial<Ask> = {}): Ask => ({
  id,
  state: 'open',
  text: `question ${id}`,
  choices: ['Yes', 'No'],
  agent: { key: 'k', paneId: '%1', kind: 'claude', ref: 'web:claude' },
  created: '2026-11-24T09:55:00Z',
  updated: `${id}-1`,
  live: { status: 'running', paneId: '%1', ref: 'web:claude' },
  ...over,
})

const settle = () => act(async () => {})

describe('ChatAsks', () => {
  beforeEach(() => {
    resetJobs()
    api.fetchAsks.mockReset()
    api.answerAsk.mockReset()
  })
  afterEach(() => resetJobs())

  it("shows only the open questions of this pane's running orchestrator", async () => {
    api.fetchAsks.mockResolvedValue({
      asks: [
        ask('Q1'),
        ask('Q2', { live: { status: 'running', paneId: '%2' } }),
        ask('Q3', { live: { status: 'gone', paneId: '%1' } }),
        ask('Q4', { state: 'answered', live: undefined }),
      ],
      readOnly: false,
    })
    render(<ChatAsks paneId="%1" clockOffset={0} />)
    await settle()
    expect(screen.getByRole('article', { name: 'Q1' })).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'Q2' })).toBeNull()
    expect(screen.queryByRole('article', { name: 'Q3' })).toBeNull()
    expect(screen.queryByRole('article', { name: 'Q4' })).toBeNull()
  })

  it('answers one here, then keeps the note that it went out', async () => {
    api.fetchAsks.mockResolvedValue({ asks: [ask('Q1')], readOnly: false })
    api.answerAsk.mockResolvedValue({
      ask: ask('Q1', { state: 'answered', live: undefined }),
      queued: false,
    })
    render(<ChatAsks paneId="%1" clockOffset={0} />)
    await settle()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'No' }))
    })
    expect(api.answerAsk).toHaveBeenCalledWith('Q1', {
      choice: 2,
      updated: 'Q1-1',
    })
    expect(screen.queryByRole('article', { name: 'Q1' })).toBeNull()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('shows the oldest question only, the others behind a toggle', async () => {
    api.fetchAsks.mockResolvedValue({
      asks: [ask('Q1'), ask('Q2'), ask('Q3')],
      readOnly: false,
    })
    render(<ChatAsks paneId="%1" clockOffset={0} />)
    await settle()
    expect(screen.getByRole('article', { name: 'Q1' })).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: 'Q2' })).toBeNull()
    const toggle = screen.getByRole('button', {
      name: 'Show 2 more questions',
    })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(screen.getByRole('article', { name: 'Q2' })).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Q3' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show only the first' }))
    expect(screen.queryByRole('article', { name: 'Q3' })).toBeNull()
  })

  it('points at the questions hidden below, and scrolls to them', async () => {
    api.fetchAsks.mockResolvedValue({
      asks: [ask('Q1'), ask('Q2')],
      readOnly: false,
    })
    const { container } = render(<ChatAsks paneId="%1" clockOffset={0} />)
    await settle()
    const box = container.firstElementChild?.firstElementChild as HTMLElement
    const scrollBy = vi.fn()
    box.scrollBy = scrollBy as typeof box.scrollBy
    Object.defineProperty(box, 'scrollHeight', { value: 600 })
    Object.defineProperty(box, 'clientHeight', { value: 300 })
    const label = 'Scroll to the questions below'
    expect(screen.queryByRole('button', { name: label })).toBeNull()
    fireEvent.scroll(box)
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(scrollBy).toHaveBeenCalledWith({ top: 240, behavior: 'smooth' })
    box.scrollTop = 300
    fireEvent.scroll(box)
    expect(screen.queryByRole('button', { name: label })).toBeNull()
  })

  it('measures again when the box or its content is resized', async () => {
    let fire = () => {}
    const observe = vi.fn()
    const disconnect = vi.fn()
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
    try {
      api.fetchAsks.mockResolvedValue({
        asks: [ask('Q1'), ask('Q2')],
        readOnly: false,
      })
      const { container, unmount } = render(
        <ChatAsks paneId="%1" clockOffset={0} />,
      )
      await settle()
      const box = container.firstElementChild?.firstElementChild as HTMLElement
      // The box and its section
      expect(observe).toHaveBeenCalledWith(box)
      expect(observe).toHaveBeenCalledWith(box.firstElementChild)
      Object.defineProperty(box, 'scrollHeight', { value: 600 })
      Object.defineProperty(box, 'clientHeight', { value: 300 })
      act(() => fire())
      expect(
        screen.getByRole('button', { name: 'Scroll to the questions below' }),
      ).toBeInTheDocument()
      unmount()
      expect(disconnect).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('offers no toggle for a single question', async () => {
    api.fetchAsks.mockResolvedValue({ asks: [ask('Q1')], readOnly: false })
    render(<ChatAsks paneId="%1" clockOffset={0} />)
    await settle()
    expect(screen.queryByRole('button', { name: /more question/ })).toBeNull()
  })

  it('shows nothing for another pane, nor on a view-only device', async () => {
    api.fetchAsks.mockResolvedValue({ asks: [ask('Q1')], readOnly: false })
    const { container, unmount } = render(
      <ChatAsks paneId="%9" clockOffset={0} />,
    )
    await settle()
    expect(container.firstElementChild?.firstElementChild).toBeEmptyDOMElement()
    unmount()
    resetJobs()
    api.fetchAsks.mockResolvedValue({
      asks: [{ id: 'Q1', state: 'open', created: '' }],
      readOnly: true,
    })
    const view = render(<ChatAsks paneId="%1" clockOffset={0} />)
    await settle()
    expect(
      view.container.firstElementChild?.firstElementChild,
    ).toBeEmptyDOMElement()
  })
})
