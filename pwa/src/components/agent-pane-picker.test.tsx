import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import {
  type AgentPaneChoice,
  AgentPanePicker,
  agentPanes,
  rememberAgent,
  rememberedAgent,
} from './agent-pane-picker'

const session = (over: Partial<Session>): Session => ({
  id: 's',
  name: 'Tab',
  icon: '',
  description: '',
  ...over,
})

describe('agentPanes', () => {
  it('lists the agent panes of a multi-pane tab, labelled tab · pane', () => {
    const s = session({
      id: 'a',
      name: 'Work',
      panes: [
        { id: '%1', label: 'left', hasAgent: true, agentName: 'claude' },
        { id: '%2', label: 'right', hasAgent: true, agentName: 'codex' },
      ],
    })
    expect(agentPanes([s])).toEqual([
      {
        sessionId: 'a',
        paneId: '%1',
        label: 'Work · left',
        agentName: 'claude',
      },
      {
        sessionId: 'a',
        paneId: '%2',
        label: 'Work · right',
        agentName: 'codex',
      },
    ])
  })

  it('labels a single pane by the tab name only', () => {
    const s = session({
      id: 'a',
      name: 'Solo',
      panes: [{ id: '%1', label: 'p', hasAgent: true, agentName: 'claude' }],
    })
    expect(agentPanes([s])[0].label).toBe('Solo')
  })

  it('skips panes without an agent, with one that takes no message, and the excluded one', () => {
    const s = session({
      id: 'a',
      name: 'Work',
      panes: [
        { id: '%1', label: 'a', hasAgent: false },
        { id: '%2', label: 'b', hasAgent: true, agentName: 'gemini' },
        { id: '%3', label: 'c', hasAgent: true },
        { id: '%4', label: 'd', hasAgent: true, agentName: 'claude' },
        { id: '%5', label: 'e', hasAgent: true, agentName: 'claude' },
      ],
    })
    expect(agentPanes([s], '%4').map((c) => c.paneId)).toEqual(['%5'])
  })

  it('uses the tab itself when it has no panes list', () => {
    const s = session({
      id: 'a',
      name: 'Plain',
      paneId: '%9',
      hasAgent: true,
      agentName: 'codex',
    })
    expect(agentPanes([s])).toEqual([
      { sessionId: 'a', paneId: '%9', label: 'Plain', agentName: 'codex' },
    ])
    // An empty panes list falls back to the tab as well
    expect(agentPanes([{ ...s, panes: [] }])).toHaveLength(1)
  })

  it('excludes a tab-level pane, and tabs without an agent, a pane or an input agent', () => {
    const ok = session({ paneId: '%9', hasAgent: true, agentName: 'claude' })
    expect(agentPanes([ok], '%9')).toEqual([])
    expect(agentPanes([{ ...ok, paneId: undefined }])).toEqual([])
    expect(agentPanes([{ ...ok, hasAgent: false }])).toEqual([])
    expect(agentPanes([{ ...ok, agentName: 'gemini' }])).toEqual([])
  })
})

describe('rememberedAgent / rememberAgent', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns null when nothing was remembered, then the pane per group', () => {
    expect(rememberedAgent('g1')).toBeNull()
    rememberAgent('g1', '%3')
    rememberAgent('g2', '%4')
    expect(rememberedAgent('g1')).toBe('%3')
    expect(rememberedAgent('g2')).toBe('%4')
    expect(localStorage.getItem('termote-task-agent:g1')).toBe('%3')
  })

  it('survives a storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(rememberedAgent('g1')).toBeNull()
    expect(() => rememberAgent('g1', '%3')).not.toThrow()
  })
})

describe('AgentPanePicker', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })

  it('says so when no pane runs an agent', () => {
    render(
      <AgentPanePicker
        isOpen
        choices={[]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Send to which agent?')).toBeInTheDocument()
    expect(screen.getByText(/No pane runs an agent/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Claude Code/ })).toBeNull()
  })

  it('renders nothing when closed', () => {
    render(
      <AgentPanePicker
        isOpen={false}
        choices={[]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByText('Send to which agent?')).toBeNull()
  })

  it('lists the choices with their agent and picks one', () => {
    const choices: AgentPaneChoice[] = [
      {
        sessionId: 'a',
        paneId: '%1',
        label: 'Work · left',
        agentName: 'claude',
      },
      { sessionId: 'b', paneId: '%2', label: 'Evil‮name', agentName: 'codex' },
    ]
    const onPick = vi.fn()
    render(
      <AgentPanePicker
        isOpen
        choices={choices}
        onPick={onPick}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByText(/No pane runs an agent/)).toBeNull()
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('Codex')).toBeInTheDocument()
    // An invisible bidi mark in a name is shown, not applied
    expect(screen.getByText('Evil⟨U+202E⟩name')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Work · left/ }))
    expect(onPick).toHaveBeenCalledWith(choices[0])
  })

  it('closes from the close button', () => {
    const onClose = vi.fn()
    render(
      <AgentPanePicker
        isOpen
        choices={[]}
        onPick={vi.fn()}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })
})
