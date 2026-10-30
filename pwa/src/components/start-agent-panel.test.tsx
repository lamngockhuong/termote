import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StartAgentPanel } from './start-agent-panel'

describe('StartAgentPanel', () => {
  it('offers Claude Code and Codex', () => {
    const onStart = vi.fn()
    render(<StartAgentPanel kinds={['claude', 'codex']} onStart={onStart} />)
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }))
    fireEvent.click(screen.getByRole('button', { name: 'Claude Code' }))
    expect(onStart.mock.calls).toEqual([['codex'], ['claude']])
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('disables both while a start is pending', () => {
    const onStart = vi.fn()
    render(
      <StartAgentPanel
        kinds={['claude', 'codex']}
        record={{ kind: 'codex', phase: 'sending', since: 0 }}
        onStart={onStart}
      />,
    )
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[]
    expect(buttons.map((b) => b.disabled)).toEqual([true, true])
    expect(screen.getByRole('status').textContent).toContain('Starting Codex…')
  })

  it('shows the error of a refused start, buttons back', () => {
    render(
      <StartAgentPanel
        kinds={['claude', 'codex']}
        record={{
          kind: 'claude',
          phase: 'failed',
          error: 'dialogs.startAgent.failed',
          since: 0,
        }}
        onStart={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert').textContent).toBe(
      'Could not start the agent.',
    )
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[]
    expect(buttons.every((b) => !b.disabled)).toBe(true)
  })
})
