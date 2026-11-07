import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubagentNode, Subagents } from '../hooks/use-mux-api'

const store = vi.hoisted(() => ({
  tree: undefined as Subagents | undefined,
  pane: '',
  open: false,
}))
vi.mock('../hooks/use-subagents', () => ({
  useSubagents: (pane: string, open: boolean) => {
    store.pane = pane
    store.open = open
    return { tree: store.tree, error: false }
  },
}))

import { ChatSubagents, runningSubagents } from './chat-subagents'

const START = Date.parse('2026-10-13T10:00:00Z')
const node = (over: Partial<SubagentNode>): SubagentNode => ({
  id: 'a',
  type: 'Explore',
  status: 'running',
  depth: 1,
  children: [],
  ...over,
})

describe('runningSubagents', () => {
  it('keeps the running ones and the ones above them', () => {
    const nested = node({ id: 'c', depth: 2 })
    const nodes = [
      node({ id: 'done', status: 'done' }),
      node({ id: 'p', status: 'done', children: [nested] }),
      node({
        id: 'r',
        children: [node({ id: 'e', status: 'error', depth: 2 })],
      }),
    ]
    expect(runningSubagents(nodes)).toEqual([
      { ...nodes[1], children: [nested] },
      { ...nodes[2], children: [] },
    ])
    expect(runningSubagents([])).toEqual([])
  })
})

describe('ChatSubagents', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
    store.tree = undefined
  })
  afterEach(() => vi.useRealTimers())

  it('draws nothing while none runs', () => {
    const { container, rerender } = render(<ChatSubagents paneId="p1" />)
    expect(store).toMatchObject({ pane: 'p1', open: true })
    expect(container).toBeEmptyDOMElement()
    store.tree = { nodes: [node({ status: 'done' })] }
    rerender(<ChatSubagents paneId="p1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists the running ones, their time and tokens, and folds', () => {
    store.tree = {
      nodes: [
        node({
          id: 'r1',
          type: 'seo-technical',
          description: 'SEO technical audit',
          // Written by a server 5 s ahead of this device
          startTs: '2026-10-13T10:00:05Z',
          tokens: 30_300,
          lastTool: 'Read',
        }),
        node({ id: 'r2', type: 'seo-content' }),
        node({ id: 'd', type: 'finished', status: 'done' }),
      ],
    }
    render(<ChatSubagents paneId="p1" clockOffset={5000} />)
    const toggle = screen.getByRole('button', { name: '2 subagents running' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent(
      'seo-technical· running · 0 s · ↓ 30k tokens',
    )
    expect(items[0]).toHaveTextContent('SEO technical audit')
    expect(screen.queryByText('finished')).toBeNull()
    // The time runs on each second
    act(() => vi.advanceTimersByTime(3000))
    expect(items[0]).toHaveTextContent('running · 3 s')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('says one in the singular', () => {
    store.tree = { nodes: [node({})] }
    render(<ChatSubagents paneId="p1" />)
    expect(
      screen.getByRole('button', { name: '1 subagent running' }),
    ).toBeInTheDocument()
  })
})
