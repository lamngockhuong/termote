import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { HistorySession } from '../hooks/use-mux-api'
import { AgentHistoryRow, HistoryTitle } from './agent-history-row'

const now = Date.parse('2026-11-14T12:00:00Z')
const S: HistorySession = {
  agent: 'codex',
  id: 'id-1',
  title: 'Fix the login',
  titleSource: 'custom',
  cwd: 'pkg/web',
  branch: 'feat/login',
  updatedAt: '2026-11-12T12:00:00Z',
  live: { tabId: 't', paneId: 'p' },
}

describe('AgentHistoryRow', () => {
  it('shows the agent, title, age, branch, folder and that it runs', () => {
    const onOpen = vi.fn()
    const { container } = render(
      <AgentHistoryRow session={S} now={now} onOpen={onOpen} />,
    )
    expect(container.querySelector('[data-agent-logo="codex"]')).toBeTruthy()
    expect(screen.getByText('Fix the login').className).toBe('')
    expect(screen.getByText('2 d ago')).toBeTruthy()
    expect(screen.getByText('feat/login')).toBeTruthy()
    expect(screen.getByText('pkg/web/')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
    fireEvent.click(screen.getByRole('button'))
    expect(onOpen).toHaveBeenCalledWith(S)
  })

  it('leaves out what a session lacks', () => {
    render(
      <AgentHistoryRow
        session={{ ...S, branch: undefined, cwd: '', live: undefined }}
        now={now}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.queryByText('pkg/web/')).toBeNull()
  })
})

describe('HistoryTitle', () => {
  it('reads a prompt lighter and names an untitled session', () => {
    const { rerender } = render(
      <HistoryTitle session={{ ...S, titleSource: 'prompt' }} />,
    )
    expect(screen.getByText('Fix the login').className).toContain('italic')
    rerender(<HistoryTitle session={{ ...S, title: '' }} />)
    expect(screen.getByText('Untitled session').className).toContain('italic')
  })
})
