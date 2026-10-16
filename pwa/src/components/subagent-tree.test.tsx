import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { SubagentNode } from '../hooks/use-mux-api'
import {
  flattenSubagents,
  SUBAGENT_TREE_MAX,
  SubagentTree,
  subagentDuration,
  subagentSummary,
} from './subagent-tree'

const NOW = Date.parse('2026-10-13T10:00:00Z')
const node = (over: Partial<SubagentNode>): SubagentNode => ({
  id: 'a',
  type: 'Explore',
  status: 'running',
  depth: 1,
  children: [],
  ...over,
})

const TREE = {
  nodes: [
    node({
      id: 'a1',
      type: 'code-reviewer',
      description: 'Review parser',
      status: 'done',
      startTs: '2026-10-13T09:50:00Z',
      endTs: '2026-10-13T09:53:30Z',
      lastTool: 'Read',
    }),
    node({
      id: 'a2',
      description: 'Trace the lexer',
      startTs: '2026-10-13T09:59:18Z',
      lastTool: 'Grep',
      children: [
        node({
          id: 'a4',
          type: 'general-purpose',
          status: 'error',
          depth: 2,
          startTs: '2026-10-13T08:00:00Z',
          endTs: '2026-10-13T10:00:00Z',
        }),
      ],
    }),
    node({ id: 'a3', status: 'done', statusGuessed: true }),
  ],
}

describe('SubagentTree text', () => {
  it('shows the hidden characters of a description and a tool', () => {
    render(
      <SubagentTree
        tree={{
          nodes: [
            node({ description: 'fix \u202etxt.exe', lastTool: 'Read\u061c' }),
          ],
        }}
        error={false}
        now={NOW}
      />,
    )
    expect(screen.getByText('fix ⟨U+202E⟩txt.exe')).toBeInTheDocument()
    expect(screen.getByText('Read⟨U+061C⟩')).toBeInTheDocument()
  })
})

describe('subagent helpers', () => {
  it('counts and times subagents', () => {
    expect(flattenSubagents(TREE.nodes).map((n) => n.id)).toEqual([
      'a1',
      'a2',
      'a4',
      'a3',
    ])
    expect(subagentSummary(TREE)).toBe('4 subagents, 1 running')
    expect(subagentSummary({ nodes: [node({ status: 'done' })] })).toBe(
      '1 subagent',
    )
    expect(subagentSummary({ nodes: [] })).toBeUndefined()
    expect(subagentSummary(undefined)).toBeUndefined()
    const [a1, a2, a4, a3] = flattenSubagents(TREE.nodes)
    expect(subagentDuration(a1, NOW)).toBe('3 min')
    expect(subagentDuration(a2, NOW)).toBe('42 s')
    expect(subagentDuration(a4, NOW)).toBe('2 h')
    expect(subagentDuration(a3, NOW)).toBeUndefined()
    expect(
      subagentDuration(node({ status: 'done', startTs: 'x' }), NOW),
    ).toBeUndefined()
  })
})

describe('SubagentTree', () => {
  it('lists each subagent with its status, indented by depth', () => {
    render(<SubagentTree tree={TREE} error={false} now={NOW} />)
    const items = within(
      screen.getByRole('list', { name: 'Subagents' }),
    ).getAllByRole('listitem')
    expect(items.map((li) => li.getAttribute('data-status'))).toEqual([
      'done',
      'running',
      'error',
      'done',
    ])
    expect(items[0]).toHaveTextContent('code-reviewer· done · 3 min')
    expect(items[0]).toHaveTextContent('Review parser')
    expect(items[1]).toHaveTextContent('Grep')
    expect(items[2]).toHaveTextContent('failed')
    expect(items[2].style.marginLeft).toBe('12px')
    expect(items[3]).toHaveTextContent('done (guessed)')
    // Only a running subagent's icon glows, and only with motion allowed
    const pulsing = document.querySelectorAll('[class*="animate-pulse"]')
    expect(pulsing).toHaveLength(1)
    expect(pulsing[0].getAttribute('class')).toMatch(
      /motion-safe:animate-pulse/,
    )
    expect(items[1].contains(pulsing[0])).toBe(true)
  })

  it('counts what it does not draw', () => {
    const many = Array.from({ length: SUBAGENT_TREE_MAX + 3 }, (_, i) =>
      node({ id: `n${i}` }),
    )
    const { rerender } = render(
      <SubagentTree tree={{ nodes: many }} error={false} now={NOW} />,
    )
    expect(screen.getAllByRole('listitem')).toHaveLength(SUBAGENT_TREE_MAX)
    expect(screen.getByText('and 3 more')).toBeInTheDocument()
    rerender(
      <SubagentTree
        tree={{ nodes: [node({})], truncated: true }}
        error={false}
        now={NOW}
      />,
    )
    expect(
      screen.getByText('Older or deeper subagents not shown'),
    ).toBeInTheDocument()
  })

  it('waits, fails or has none', () => {
    const { container, rerender } = render(
      <SubagentTree error={false} now={NOW} />,
    )
    expect(
      container.querySelector('.motion-safe\\:animate-pulse'),
    ).not.toBeNull()
    rerender(<SubagentTree error now={NOW} />)
    expect(screen.getByText('Could not read subagents.')).toBeInTheDocument()
    rerender(<SubagentTree tree={{ nodes: [] }} error={false} now={NOW} />)
    expect(screen.getByText('No subagents.')).toBeInTheDocument()
  })
})
