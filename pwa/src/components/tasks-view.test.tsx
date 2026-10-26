import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NotifyOptions, ViewProps } from '../app-views'
import {
  type PaneTasks,
  RequestError,
  type TaskRun,
  type TaskRunStart,
} from '../hooks/use-mux-api'
import type { Session } from '../types/session'
import TasksView from './tasks-view'

const mockTasks = vi.fn()
const mockRun = vi.fn()
const mockRunState = vi.fn()
const mockText = vi.fn()
const mockTranscript = vi.fn()
const mockSend = vi.fn()

vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchTasks: (...a: unknown[]) => mockTasks(...a),
  runTask: (...a: unknown[]) => mockRun(...a),
  fetchTaskRun: (...a: unknown[]) => mockRunState(...a),
  fetchPaneText: (...a: unknown[]) => mockText(...a),
  fetchTranscript: (...a: unknown[]) => mockTranscript(...a),
  sendAgentMessage: (...a: unknown[]) => mockSend(...a),
}))

const NONCE = '0123456789abcdef'
const RUN: TaskRun = {
  runId: 'run1',
  tabId: 'tab1',
  paneId: '%run',
  nonce: NONCE,
  state: 'exited',
  code: 1,
}
const START: TaskRunStart = {
  runId: 'run2',
  tabId: 'tab2',
  paneId: '%new',
  nonce: NONCE,
  reused: false,
}
const OUTPUT_TEXT = `$ pnpm run test\n[termote-task ${NONCE} start]\nboom\n[termote-task ${NONCE} exit 1]\n`

const tasks = (over: Partial<PaneTasks> = {}): PaneTasks => ({
  root: '/home/u/proj',
  packageManager: 'pnpm',
  scripts: [
    { name: 'test', command: 'vitest run' },
    { name: 'build', command: 'vite build' },
  ],
  makefile: 'Makefile',
  makeTargets: [{ name: 'lint' }],
  userTasks: [
    {
      id: 'aaaaaaaaaaaaaaaa',
      name: 'Deploy',
      command: './deploy.sh',
      updated: '',
    },
  ],
  runs: {},
  skipped: 0,
  tooLarge: [],
  ...over,
})

const AGENT: Session = {
  id: 'agent-tab',
  name: 'Agent',
  icon: '',
  description: '',
  paneId: '%agent',
  hasAgent: true,
  agentName: 'claude',
}

function props(over: Partial<ViewProps> = {}): ViewProps {
  return {
    mux: {
      backend: 'zellij',
      caps: {
        clientSideSelect: false,
        copyMode: false,
        paneText: true,
        agentChat: true,
      },
    },
    session: {
      id: '1',
      name: 'Shell',
      icon: '',
      description: '',
      paneId: '%1',
      groupId: 'g1',
    },
    readOnly: false,
    isMobile: false,
    notify: vi.fn(),
    showView: vi.fn(),
    sessions: [AGENT],
    openTab: vi.fn(),
    refreshSessions: vi.fn(async () => {}),
    ...over,
  }
}

async function show(data: PaneTasks = tasks(), over: Partial<ViewProps> = {}) {
  mockTasks.mockResolvedValue(data)
  const p = props(over)
  const view = render(<TasksView {...p} />)
  await screen.findByTestId('tasks-view')
  return { ...p, ...view }
}

const notifyCall = (p: ViewProps, i = -1) => {
  const calls = (p.notify as ReturnType<typeof vi.fn>).mock.calls
  const [message, options] = calls.at(i) as [string, NotifyOptions | undefined]
  return { message, options }
}
const rowOf = (name: string) =>
  screen
    .getAllByTestId('task-row')
    .find((r) => within(r).queryByText(name)) as HTMLElement
const clickIn = (row: HTMLElement, name: RegExp | string) =>
  fireEvent.click(within(row).getByRole('button', { name }))

beforeEach(() => {
  for (const m of [
    mockTasks,
    mockRun,
    mockRunState,
    mockText,
    mockTranscript,
    mockSend,
  ])
    m.mockReset()
  mockRunState.mockResolvedValue({ state: 'running' })
  mockText.mockResolvedValue({ text: OUTPUT_TEXT })
  mockTranscript.mockResolvedValue({ cursor: 'c1' })
  mockSend.mockResolvedValue(undefined)
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

describe('TasksView listing', () => {
  it('shows Loading without a pane and reads nothing', () => {
    render(
      <TasksView
        {...props({
          session: { id: '1', name: 'S', icon: '', description: '' },
        })}
      />,
    )
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(mockTasks).not.toHaveBeenCalled()
  })

  it('shows Loading until the list arrives, reading the pane', async () => {
    mockTasks.mockReturnValue(new Promise(() => {}))
    render(<TasksView {...props()} />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(mockTasks).toHaveBeenCalledWith('%1', undefined)
  })

  it.each([
    [new RequestError(400, 'x', 'bad'), 'Directory not found'],
    [new RequestError(403, 'x', 'no'), "This directory can't be shown"],
    [new RequestError(501, 'x', 'no'), 'Not supported by this backend'],
    [new RequestError(500, 'x', 'boom'), 'Could not read the tasks'],
    [new Error('network'), 'Could not read the tasks'],
  ])('tells a list error: %s', async (err, text) => {
    mockTasks.mockRejectedValue(err)
    render(<TasksView {...props()} />)
    expect(await screen.findByText(text)).toBeInTheDocument()
    expect(screen.queryByTestId('tasks-view')).toBeNull()
  })

  it('says so when the folder offers nothing, with no filter box', async () => {
    await show(
      tasks({ scripts: [], makeTargets: [], userTasks: [], makefile: '' }),
    )
    expect(
      screen.getByText(
        'No package.json script, Makefile target or task of yours here',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Filter tasks')).toBeNull()
    expect(screen.queryByTestId('task-row')).toBeNull()
  })

  it('groups scripts, make targets and user tasks under their titles', async () => {
    await show()
    expect(screen.getByTestId('pane-root')).toHaveAttribute(
      'title',
      '/home/u/proj',
    )
    const scripts = screen.getByRole('region', { name: 'Scripts (pnpm)' })
    expect(within(scripts).getAllByTestId('task-row')).toHaveLength(2)
    expect(within(scripts).getByText('vitest run')).toBeInTheDocument()
    const make = screen.getByRole('region', { name: 'Make (Makefile)' })
    expect(within(make).getByText('make lint')).toBeInTheDocument()
    const mine = screen.getByRole('region', { name: 'My tasks' })
    expect(within(mine).getByText('./deploy.sh')).toBeInTheDocument()
  })

  it('hides empty groups and names npm when no package manager is reported', async () => {
    await show(tasks({ packageManager: '', makeTargets: [], userTasks: [] }))
    expect(
      screen.getByRole('region', { name: 'Scripts (npm)' }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /Make/ })).toBeNull()
    expect(screen.queryByRole('region', { name: 'My tasks' })).toBeNull()
  })

  it('warns about files too large to read, and counts what was left out', async () => {
    await show(tasks({ tooLarge: ['package.json', 'Makefile'], skipped: 3 }))
    expect(
      screen.getByText('Too large to read: package.json, Makefile'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('3 left out: a name Termote does not run'),
    ).toBeInTheDocument()
  })

  it('shows neither the banner nor the note when there is nothing to tell', async () => {
    await show()
    expect(screen.queryByText(/Too large to read/)).toBeNull()
    expect(screen.queryByText(/left out/)).toBeNull()
  })

  it('filters by name or command, ignoring case and outer spaces', async () => {
    await show()
    const box = screen.getByLabelText('Filter tasks')
    fireEvent.change(box, { target: { value: '  BUILD ' } })
    expect(screen.getAllByTestId('task-row')).toHaveLength(1)
    expect(screen.getByText('vite build')).toBeInTheDocument()
    // The command matches too, and groups left empty disappear
    fireEvent.change(box, { target: { value: 'deploy.sh' } })
    expect(screen.getAllByTestId('task-row')).toHaveLength(1)
    expect(screen.queryByRole('region', { name: 'Scripts (pnpm)' })).toBeNull()
    expect(screen.getByRole('region', { name: 'My tasks' })).toBeInTheDocument()
    fireEvent.change(box, { target: { value: '' } })
    expect(screen.getAllByTestId('task-row')).toHaveLength(4)
  })

  it('reads the list again from Refresh', async () => {
    await show()
    expect(mockTasks).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(mockTasks).toHaveBeenCalledTimes(2))
    expect(mockTasks).toHaveBeenLastCalledWith('%1', '/home/u/proj')
  })
})

describe('TasksView Run', () => {
  it('runs a task, tells it and offers its tab', async () => {
    mockRun.mockResolvedValue(START)
    const p = await show()
    clickIn(rowOf('test'), 'Run test')
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    expect(mockRun).toHaveBeenCalledWith('%1', {
      kind: 'script',
      name: 'test',
      root: '/home/u/proj',
      newTab: false,
    })
    expect(p.refreshSessions).toHaveBeenCalled()
    const { message, options } = notifyCall(p)
    expect(message).toBe('Running in tab task:test')
    expect(options?.variant).toBe('success')
    expect(options?.action?.label).toBe('Open')
    options?.action?.onClick()
    expect(p.openTab).toHaveBeenCalledWith('tab2', '%new')
    // The row shows the run, and Run is enabled again
    expect(
      within(rowOf('test')).getByTestId('task-run-state'),
    ).toHaveTextContent('running')
    expect(
      within(rowOf('test')).getByRole('button', { name: 'Run test' }),
    ).toBeEnabled()
  })

  it('runs a user task by id', async () => {
    mockRun.mockResolvedValue(START)
    const p = await show()
    clickIn(rowOf('Deploy'), 'Run Deploy')
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    expect(mockRun).toHaveBeenCalledWith('%1', {
      kind: 'user',
      id: 'aaaaaaaaaaaaaaaa',
      root: '/home/u/proj',
      newTab: false,
    })
  })

  it('disables Run of that task while the server answers', async () => {
    let done: (s: TaskRunStart) => void = () => {}
    mockRun.mockReturnValue(new Promise((r) => (done = r)))
    await show()
    clickIn(rowOf('test'), 'Run test')
    await waitFor(() =>
      expect(
        within(rowOf('test')).getByRole('button', { name: 'Run test' }),
      ).toBeDisabled(),
    )
    expect(
      within(rowOf('build')).getByRole('button', { name: 'Run build' }),
    ).toBeEnabled()
    await act(async () => done(START))
    expect(
      within(rowOf('test')).getByRole('button', { name: 'Run test' }),
    ).toBeEnabled()
  })

  it('works without openTab and refreshSessions', async () => {
    mockRun.mockResolvedValue(START)
    const p = await show(tasks(), {
      openTab: undefined,
      refreshSessions: undefined,
    })
    clickIn(rowOf('test'), 'Run test')
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    expect(() => notifyCall(p).options?.action?.onClick()).not.toThrow()
  })

  it.each([
    ['no_client', 'Open this session in Zellij first'],
    [
      'unsupported_shell',
      'This shell is not supported (bash, zsh, sh, fish, pwsh)',
    ],
    ['shell_busy', "The tab's shell is busy"],
    ['task_not_found', 'This task is no longer in the folder'],
    ['tab_gone', "The task's tab was closed"],
    ['invalid_task', 'This task cannot be run: edit it in Settings'],
    ['invalid_root', "This folder's name cannot be used for a task"],
    ['something_new', 'Could not run the task'],
  ])('a refused Run (%s) tells %s', async (code, text) => {
    mockRun.mockRejectedValue(new RequestError(409, code, 'server text'))
    const p = await show()
    clickIn(rowOf('test'), 'Run test')
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    expect(notifyCall(p)).toEqual({
      message: text,
      options: { variant: 'danger' },
    })
    // Never the server's own text
    expect(notifyCall(p).message).not.toContain('server text')
  })

  it('a failure that is not a request error is a plain danger toast', async () => {
    mockRun.mockRejectedValue(new Error('offline'))
    const p = await show()
    clickIn(rowOf('test'), 'Run test')
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    expect(notifyCall(p)).toEqual({
      message: 'Could not run the task',
      options: { variant: 'danger' },
    })
  })

  it('task_not_found reads the list again', async () => {
    mockRun.mockRejectedValue(new RequestError(404, 'task_not_found', 'gone'))
    const p = await show()
    clickIn(rowOf('test'), 'Run test')
    await waitFor(() => expect(mockTasks).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
  })

  it('task_running offers a run in a new tab', async () => {
    mockRun.mockRejectedValueOnce(
      new RequestError(409, 'task_running', 'running', {
        runId: 'run1',
        tabId: 'tab1',
      }),
    )
    mockRun.mockResolvedValueOnce(START)
    const p = await show()
    clickIn(rowOf('test'), 'Run test')
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    const first = notifyCall(p)
    expect(first.message).toBe('Already running')
    expect(first.options?.variant).toBeUndefined()
    expect(first.options?.action?.label).toBe('Run in new tab')
    await act(async () => first.options?.action?.onClick())
    await waitFor(() => expect(mockRun).toHaveBeenCalledTimes(2))
    expect(mockRun).toHaveBeenLastCalledWith('%1', {
      kind: 'script',
      name: 'test',
      root: '/home/u/proj',
      newTab: true,
    })
    await waitFor(() =>
      expect(notifyCall(p).message).toBe('Running in tab task:test'),
    )
  })

  it('a changed root is told as a warning and the list is read again', async () => {
    mockRun.mockRejectedValue(
      new RequestError(409, 'root_changed', 'moved', { root: '/home/u/other' }),
    )
    const p = await show()
    clickIn(rowOf('test'), 'Run test')
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    expect(notifyCall(p)).toEqual({
      message: "The pane's folder changed: the list was read again",
      options: { variant: 'warning' },
    })
    await waitFor(() => expect(mockTasks).toHaveBeenCalledTimes(2))
  })
})

describe('TasksView Open', () => {
  it('opens the tab of the last run', async () => {
    const p = await show(tasks({ runs: { 'script:test': RUN } }))
    expect(
      within(rowOf('test')).getByTestId('task-run-state'),
    ).toHaveTextContent('exit 1')
    clickIn(rowOf('test'), 'Open the tab of test')
    expect(p.openTab).toHaveBeenCalledWith('tab1', '%run')
  })
})

describe('TasksView Send to agent', () => {
  const failed = () => tasks({ runs: { 'script:test': RUN } })
  const sendButton = () =>
    within(rowOf('test')).getByRole('button', {
      name: 'Send the output of test to an agent',
    })

  it('hides Send when the backend lacks pane text or agent chat', async () => {
    const base = props().mux
    await show(failed(), {
      mux: { ...base, caps: { ...base.caps, paneText: false } },
    })
    expect(
      within(rowOf('test')).queryByRole('button', { name: /Send the output/ }),
    ).toBeNull()
  })

  it('hides Send without agent chat', async () => {
    const base = props().mux
    await show(failed(), {
      mux: { ...base, caps: { ...base.caps, agentChat: false } },
    })
    expect(
      within(rowOf('test')).queryByRole('button', { name: /Send the output/ }),
    ).toBeNull()
  })

  it('sends at once to the agent remembered for the group', async () => {
    localStorage.setItem('termote-task-agent:g1', '%agent')
    const p = await show(failed())
    fireEvent.click(sendButton())
    await waitFor(() => expect(mockSend).toHaveBeenCalled())
    expect(screen.queryByText('Send to which agent?')).toBeNull()
    // The output between the run's markers, read from the run's pane
    expect(mockText).toHaveBeenCalledWith('%run', expect.any(Number))
    expect(mockTranscript).toHaveBeenCalledWith('%agent')
    const [pane, message, cursor] = mockSend.mock.calls[0]
    expect(pane).toBe('%agent')
    expect(cursor).toBe('c1')
    expect(message).toContain('`pnpm run test` failed (exit 1) in /home/u/proj')
    expect(message).toContain('boom')
    expect(message).not.toContain('termote-task')
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    const { message: toast, options } = notifyCall(p)
    expect(toast).toBe('Sent to Claude Code')
    expect(options?.variant).toBe('success')
    expect(options?.action?.label).toBe('Open chat')
    options?.action?.onClick()
    expect(p.openTab).toHaveBeenCalledWith('agent-tab', '%agent', 'chat')
    expect(localStorage.getItem('termote-task-agent:g1')).toBe('%agent')
  })

  it('disables Send while it is sending', async () => {
    localStorage.setItem('termote-task-agent:g1', '%agent')
    let done: () => void = () => {}
    mockSend.mockReturnValue(new Promise<void>((r) => (done = r)))
    await show(failed())
    fireEvent.click(sendButton())
    await waitFor(() => expect(sendButton()).toBeDisabled())
    await act(async () => done())
    expect(sendButton()).toBeEnabled()
  })

  it('asks which agent when none is remembered, then sends and remembers it', async () => {
    const p = await show(failed())
    fireEvent.click(sendButton())
    expect(screen.getByText('Send to which agent?')).toBeInTheDocument()
    expect(mockSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Agent.*Claude Code/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalled())
    expect(localStorage.getItem('termote-task-agent:g1')).toBe('%agent')
    expect(screen.queryByText('Send to which agent?')).toBeNull()
    await waitFor(() =>
      expect(notifyCall(p).message).toBe('Sent to Claude Code'),
    )
  })

  it('asks again when the remembered pane is no longer an agent pane', async () => {
    localStorage.setItem('termote-task-agent:g1', '%gone')
    await show(failed())
    fireEvent.click(sendButton())
    expect(screen.getByText('Send to which agent?')).toBeInTheDocument()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('never offers the pane of the run itself', async () => {
    const self: Session = { ...AGENT, id: 'self', name: 'Self', paneId: '%run' }
    await show(failed(), { sessions: [self, AGENT] })
    fireEvent.click(sendButton())
    expect(screen.queryByRole('button', { name: /Self/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Agent/ })).toBeInTheDocument()
  })

  it('says so in the picker when there are no agent panes, and it closes', async () => {
    await show(failed(), { sessions: undefined })
    fireEvent.click(sendButton())
    expect(screen.getByText(/No pane runs an agent/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(screen.queryByText('Send to which agent?')).toBeNull()
  })

  it('uses a group-less key when the tab has no group', async () => {
    await show(failed(), {
      session: { id: '1', name: 'S', icon: '', description: '', paneId: '%1' },
    })
    fireEvent.click(sendButton())
    fireEvent.click(screen.getByRole('button', { name: /Agent/ }))
    await waitFor(() => expect(mockSend).toHaveBeenCalled())
    expect(localStorage.getItem('termote-task-agent:')).toBe('%agent')
  })

  it('warns when the run output is no longer in its tab', async () => {
    localStorage.setItem('termote-task-agent:g1', '%agent')
    mockText.mockResolvedValue({ text: 'cleared\n' })
    const p = await show(failed())
    fireEvent.click(sendButton())
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    expect(notifyCall(p)).toEqual({
      message: "The run's output is no longer in its tab",
      options: { variant: 'warning' },
    })
    expect(mockTranscript).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
    expect(sendButton()).toBeEnabled()
  })

  it('says the status is unknown for a run that only ended', async () => {
    localStorage.setItem('termote-task-agent:g1', '%agent')
    const p = await show(
      tasks({
        runs: { 'script:test': { ...RUN, state: 'ended', code: undefined } },
      }),
    )
    fireEvent.click(sendButton())
    await waitFor(() => expect(mockSend).toHaveBeenCalled())
    expect(mockSend.mock.calls[0][1]).toContain('ended (exit status unknown)')
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
  })

  it('names a Codex pane in the toast', async () => {
    localStorage.setItem('termote-task-agent:g1', '%agent')
    const p = await show(failed(), {
      sessions: [{ ...AGENT, agentName: 'codex' }],
    })
    fireEvent.click(sendButton())
    await waitFor(() => expect(notifyCall(p).message).toBe('Sent to Codex'))
  })

  it('retries once with a fresh cursor after session_changed', async () => {
    localStorage.setItem('termote-task-agent:g1', '%agent')
    mockTranscript
      .mockResolvedValueOnce({ cursor: 'old' })
      .mockResolvedValueOnce({ cursor: 'new' })
    mockSend
      .mockRejectedValueOnce(new RequestError(409, 'session_changed', 'moved'))
      .mockResolvedValueOnce(undefined)
    const p = await show(failed())
    fireEvent.click(sendButton())
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2))
    expect(mockSend.mock.calls[0][2]).toBe('old')
    expect(mockSend.mock.calls[1][2]).toBe('new')
    expect(mockSend.mock.calls[1][1]).toBe(mockSend.mock.calls[0][1])
    await waitFor(() =>
      expect(notifyCall(p).message).toBe('Sent to Claude Code'),
    )
  })

  it('gives up when the retry fails too', async () => {
    localStorage.setItem('termote-task-agent:g1', '%agent')
    mockSend
      .mockRejectedValueOnce(new RequestError(409, 'session_changed', 'moved'))
      .mockRejectedValueOnce(new RequestError(409, 'session_changed', 'again'))
    const p = await show(failed())
    fireEvent.click(sendButton())
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(notifyCall(p).message).toBe('Not sent: again')
  })

  it('tells a refused send with the server text and a way to the chat', async () => {
    localStorage.setItem('termote-task-agent:g1', '%agent')
    mockSend.mockRejectedValue(
      new RequestError(409, 'agent_busy', 'agent is busy'),
    )
    const p = await show(failed())
    fireEvent.click(sendButton())
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    expect(mockSend).toHaveBeenCalledTimes(1)
    const { message, options } = notifyCall(p)
    expect(message).toBe('Not sent: agent is busy')
    expect(options?.variant).toBe('danger')
    expect(options?.action?.label).toBe('Open chat')
    options?.action?.onClick()
    expect(p.openTab).toHaveBeenCalledWith('agent-tab', '%agent', 'chat')
    expect(sendButton()).toBeEnabled()
  })

  it('tells any other failure plainly, with the same way to the chat', async () => {
    localStorage.setItem('termote-task-agent:g1', '%agent')
    mockText.mockRejectedValue(new Error('offline'))
    const p = await show(failed())
    fireEvent.click(sendButton())
    await waitFor(() => expect(p.notify).toHaveBeenCalled())
    const { message, options } = notifyCall(p)
    expect(message).toBe('Could not send the output')
    expect(options?.variant).toBe('danger')
    options?.action?.onClick()
    expect(p.openTab).toHaveBeenCalledWith('agent-tab', '%agent', 'chat')
  })
})
