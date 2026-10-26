import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TaskItem, TaskRunView } from '../hooks/use-tasks'
import { runBadge, TaskRow } from './task-row'

const item = (over: Partial<TaskItem> = {}): TaskItem => ({
  key: 'script:test',
  kind: 'script',
  name: 'test',
  command: 'vitest run',
  label: 'pnpm run test',
  ...over,
})
const run = (over: Partial<TaskRunView> = {}): TaskRunView => ({
  runId: 'r1',
  tabId: 't1',
  paneId: '%2',
  nonce: '0123456789abcdef',
  state: 'running',
  ...over,
})

function show(over: Partial<Parameters<typeof TaskRow>[0]> = {}) {
  const fns = { onRun: vi.fn(), onOpen: vi.fn(), onSend: vi.fn() }
  render(
    <ul>
      <TaskRow
        item={item()}
        starting={false}
        sending={false}
        canSend
        {...fns}
        {...over}
      />
    </ul>,
  )
  return fns
}

describe('runBadge', () => {
  it.each([
    [{ state: 'running' }, 'running', 'text-info'],
    [{ state: 'exited', code: 0 }, 'exit 0', 'text-success'],
    [{ state: 'exited', code: 2 }, 'exit 2', 'text-danger'],
    [{ state: 'ended' }, 'ended', 'text-fg-muted'],
    [{ state: 'gone' }, 'tab closed', 'text-fg-muted'],
    [{ state: 'unknown' }, 'unknown', 'text-fg-muted'],
  ] as [Partial<TaskRunView>, string, string][])('%j', (over, text, tone) => {
    expect(runBadge(run(over))).toEqual({ text, tone })
  })
})

describe('TaskRow', () => {
  it('shows the name and command, and Run only without a run', () => {
    const { onRun } = show()
    expect(screen.getByText('test')).toBeInTheDocument()
    expect(screen.getByText('vitest run')).toBeInTheDocument()
    expect(screen.queryByTestId('task-run-state')).toBeNull()
    expect(screen.queryByRole('button', { name: /Open the tab/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Send the output/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Run test' }))
    expect(onRun).toHaveBeenCalledOnce()
  })

  it('disables Run while it starts', () => {
    show({ starting: true })
    expect(screen.getByRole('button', { name: 'Run test' })).toBeDisabled()
  })

  it('running: badge and Open, no Send', () => {
    const { onOpen } = show({ run: run({ state: 'running' }) })
    expect(screen.getByTestId('task-run-state')).toHaveTextContent('running')
    expect(screen.queryByRole('button', { name: /Send the output/ })).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'Open the tab of test' }),
    )
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('exited 0: Send is secondary', () => {
    const { onSend } = show({ run: run({ state: 'exited', code: 0 }) })
    expect(screen.getByTestId('task-run-state')).toHaveTextContent('exit 0')
    const send = screen.getByRole('button', {
      name: 'Send the output of test to an agent',
    })
    fireEvent.click(send)
    expect(onSend).toHaveBeenCalledOnce()
    const failing = send.className
    // Compare to the failed run below
    document.body.innerHTML = ''
    show({ run: run({ state: 'exited', code: 1 }) })
    const primary = screen.getByRole('button', {
      name: 'Send the output of test to an agent',
    })
    expect(primary.className).not.toBe(failing)
    expect(screen.getByTestId('task-run-state')).toHaveTextContent('exit 1')
  })

  it('ended: Open and Send are offered', () => {
    show({ run: run({ state: 'ended' }) })
    expect(screen.getByTestId('task-run-state')).toHaveTextContent('ended')
    expect(screen.getByRole('button', { name: /Open the tab/ })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: /Send the output/ }),
    ).toBeEnabled()
  })

  it('gone: badge only, no Open, no Send', () => {
    show({ run: run({ state: 'gone' }) })
    expect(screen.getByTestId('task-run-state')).toHaveTextContent('tab closed')
    expect(screen.queryByRole('button', { name: /Open the tab/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Send the output/ })).toBeNull()
  })

  it('unknown: no Open, Send is still offered', () => {
    show({ run: run({ state: 'unknown' }) })
    expect(screen.queryByRole('button', { name: /Open the tab/ })).toBeNull()
    expect(
      screen.getByRole('button', { name: /Send the output/ }),
    ).toBeEnabled()
  })

  it('hides Send without canSend and disables it while sending', () => {
    show({ run: run({ state: 'exited', code: 1 }), canSend: false })
    expect(screen.queryByRole('button', { name: /Send the output/ })).toBeNull()
    document.body.innerHTML = ''
    show({ run: run({ state: 'exited', code: 1 }), sending: true })
    expect(
      screen.getByRole('button', { name: /Send the output/ }),
    ).toBeDisabled()
  })

  it('lists the hooks the package manager adds', () => {
    show({ item: item({ hooks: ['pretest', 'posttest'] }) })
    expect(screen.getByText('also runs pretest, posttest')).toBeInTheDocument()
  })

  it('shows no hooks line for none or an empty list', () => {
    show({ item: item({ hooks: [] }) })
    expect(screen.queryByText(/also runs/)).toBeNull()
  })

  it('marks a command cut by the server with an ellipsis', () => {
    show({ item: item({ command: 'long cmd', truncated: true }) })
    expect(screen.getByText('long cmd…')).toBeInTheDocument()
  })

  it('shows no ellipsis for a whole command', () => {
    show({ item: item({ command: 'whole', truncated: false }) })
    expect(screen.getByText('whole')).toBeInTheDocument()
  })

  it('makes invisible characters of names and commands visible', () => {
    show({ item: item({ name: 'a‮b', command: 'x​y' }) })
    expect(screen.getByText('a⟨U+202E⟩b')).toBeInTheDocument()
    const cmd = screen.getByText('x⟨U+200B⟩y')
    expect(cmd).toHaveAttribute('title', 'x⟨U+200B⟩y')
  })
})
