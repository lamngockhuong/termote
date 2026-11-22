import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))
vi.mock('../utils/send-to-agent', () => ({
  sendToAgent: (paneId: string, text: string) => mockSend(paneId, text),
}))

import { type DispatchTarget, OverviewDispatch } from './overview-dispatch'

const A: DispatchTarget = { paneId: '%1', name: 'Claude Code', place: 'api' }
const B: DispatchTarget = { paneId: '%2', name: 'Codex', place: 'web' }
const C: DispatchTarget = { paneId: '%3', name: 'OpenCode', place: 'docs' }

function renderBar(targets: DispatchTarget[] = [A, B]) {
  const onDelivered = vi.fn()
  const onRemove = vi.fn()
  const onClear = vi.fn()
  const props = { onDelivered, onRemove, onClear }
  const utils = render(<OverviewDispatch targets={targets} {...props} />)
  const rerender = (next: DispatchTarget[]) =>
    utils.rerender(<OverviewDispatch targets={next} {...props} />)
  return { ...utils, rerender, onDelivered, onRemove, onClear }
}

const field = () =>
  screen.getByRole('textbox', { name: 'Message for the agents picked' })
const sendButton = () => screen.getByRole('button', { name: 'Send' })
const row = (name: string) =>
  within(screen.getByRole('list', { name: 'Agents to send to' }))
    .getByText(name)
    .closest('li') as HTMLElement

describe('OverviewDispatch', () => {
  beforeEach(() => {
    mockSend.mockReset()
  })

  it('sends nothing while the message is empty or blank', () => {
    renderBar()
    expect(sendButton()).toBeDisabled()
    fireEvent.change(field(), { target: { value: '   \n' } })
    expect(sendButton()).toBeDisabled()
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('sends nothing while no agent is picked', () => {
    renderBar([])
    expect(screen.getByText('Pick the agents to send to')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unpick all' })).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.change(field(), { target: { value: 'hi' } })
    expect(sendButton()).toBeDisabled()
    fireEvent.keyDown(field(), { key: 'Enter', metaKey: true })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('counts the agents picked', () => {
    const { rerender } = renderBar([A])
    expect(screen.getByText('1 agent picked')).toBeInTheDocument()
    rerender([A, B])
    expect(screen.getByText('2 agents picked')).toBeInTheDocument()
  })

  it('sends the same message to every agent and shows each outcome', async () => {
    mockSend.mockImplementation(async (paneId: string) => {
      if (paneId === '%1') return { queued: false }
      if (paneId === '%2') return { queued: true }
      throw new RequestError(503, 'agent_unavailable', 'down')
    })
    const { onDelivered } = renderBar([A, B, C])
    fireEvent.change(field(), { target: { value: 'run the tests' } })
    await act(async () => fireEvent.click(sendButton()))
    expect(mockSend.mock.calls).toEqual([
      ['%1', 'run the tests'],
      ['%2', 'run the tests'],
      ['%3', 'run the tests'],
    ])
    expect(row('Claude Code')).toHaveTextContent('Sent')
    expect(row('Claude Code').dataset.outcome).toBe('sent')
    expect(row('Codex')).toHaveTextContent('Queued')
    expect(row('OpenCode')).toHaveTextContent(
      "Not sent: The agent's service did not answer. Try again",
    )
    expect(onDelivered).toHaveBeenCalledWith(['%1', '%2'])
    // One failed: the message stays for the next send
    expect(field()).toHaveValue('run the tests')
    expect(screen.getByRole('status')).toHaveTextContent(
      '2 of 3 agents took the message',
    )
  })

  it('tells a failure the server never explained', async () => {
    mockSend.mockRejectedValue(new TypeError('fetch failed'))
    renderBar([A])
    fireEvent.change(field(), { target: { value: 'hi' } })
    await act(async () =>
      fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true }),
    )
    expect(row('Claude Code')).toHaveTextContent(
      'Not sent: the server did not answer',
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      '0 of 1 agent took the message',
    )
  })

  it('clears the message once every agent took it', async () => {
    mockSend.mockResolvedValue({ queued: false })
    const { onDelivered } = renderBar([A, B])
    fireEvent.change(field(), { target: { value: 'hi' } })
    await act(async () =>
      fireEvent.keyDown(field(), { key: 'Enter', metaKey: true }),
    )
    expect(onDelivered).toHaveBeenCalledWith(['%1', '%2'])
    expect(field()).toHaveValue('')
  })

  it('sends again only to the agents still picked', async () => {
    mockSend.mockImplementation(async (paneId: string) => {
      if (paneId === '%2') throw new RequestError(503, 'agent_unavailable', '')
      return { queued: false }
    })
    const { rerender } = renderBar([A, B])
    fireEvent.change(field(), { target: { value: 'hi' } })
    await act(async () => fireEvent.click(sendButton()))
    // The overview unpicks the agent that took it
    rerender([B])
    // The agent reached last time stays listed, with no way to unpick it
    expect(row('Claude Code')).toHaveTextContent('Sent')
    expect(
      screen.queryByRole('button', { name: 'Unpick Claude Code, api' }),
    ).toBeNull()
    mockSend.mockReset()
    mockSend.mockResolvedValue({ queued: true })
    await act(async () => fireEvent.click(sendButton()))
    expect(mockSend.mock.calls).toEqual([['%2', 'hi']])
    expect(row('Codex')).toHaveTextContent('Queued')
  })

  it('does not send twice while a send is under way', async () => {
    let finish: (v: { queued: boolean }) => void = () => {}
    mockSend.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    )
    renderBar([A])
    fireEvent.change(field(), { target: { value: 'hi' } })
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(field(), { key: 'Enter', ctrlKey: true })
    expect(mockSend).toHaveBeenCalledTimes(1)
    const busy = screen.getByRole('button', { name: 'Sending…' })
    expect(busy).toBeDisabled()
    fireEvent.click(busy)
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Unpick Claude Code, api' }),
    ).toBeDisabled()
    await act(async () => finish({ queued: false }))
    expect(sendButton()).toBeDisabled()
  })

  it('a plain Enter only types a new line', () => {
    renderBar([A])
    fireEvent.change(field(), { target: { value: 'hi' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('unpicks one agent or all of them', () => {
    const { onRemove, onClear } = renderBar([A, B])
    fireEvent.click(screen.getByRole('button', { name: 'Unpick Codex, web' }))
    expect(onRemove).toHaveBeenCalledWith('%2')
    fireEvent.click(screen.getByRole('button', { name: 'Unpick all' }))
    expect(onClear).toHaveBeenCalled()
  })
})
