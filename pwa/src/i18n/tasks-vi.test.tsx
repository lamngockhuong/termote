import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { AccountUsageStrip } from '../components/account-usage-strip'
import { ActivityLog, eventTime } from '../components/activity-log'
import { AgentCard, statusAge } from '../components/agent-card'
import { AgentFilterBar } from '../components/agent-filter-bar'
import { CommandPalette } from '../components/command-palette'
import { OverviewScreen } from '../components/overview-screen'
import { ShortcutsSection } from '../components/shortcuts-section'
import { TaskRow } from '../components/task-row'
import TasksView from '../components/tasks-view'
import { resetActivityLog } from '../hooks/use-activity-log'
import { resetAgentOverview } from '../hooks/use-agent-overview'
import type { PaneTasks, TaskRun } from '../hooks/use-mux-api'
import { resetAllShortcuts } from '../hooks/use-shortcuts'
import type { Session, SessionPane } from '../types/session'
import { type AppCommandContext, buildAppCommands } from '../utils/app-commands'
import { formatAgo } from '../utils/format-ago'
import { resetLabel } from '../utils/usage-format'
import { formatTime } from './format'
import { tFor } from './i18n-context'
import { renderWithLocale } from './test-utils'

// Tasks, the agent overview and the command palette in Vietnamese; what
// Send to agent sends stays in English
const tVi = tFor('vi')

const mockTasks = vi.fn()
const mockText = vi.fn()
const mockTranscript = vi.fn()
const mockSend = vi.fn()
const mockFetchOverview = vi.fn()
const mockFetchActivity = vi.fn()

vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchTasks: (...a: unknown[]) => mockTasks(...a),
  fetchTaskRun: async () => ({ state: 'exited', code: 1 }),
  fetchPaneText: (...a: unknown[]) => mockText(...a),
  fetchTranscript: (...a: unknown[]) => mockTranscript(...a),
  sendAgentMessage: (...a: unknown[]) => mockSend(...a),
  fetchOverview: () => mockFetchOverview(),
  fetchActivity: () => mockFetchActivity(),
}))
vi.mock('../utils/platform', () => ({ isApplePlatform: () => false }))
vi.mock('../hooks/use-media-query', () => ({
  useIsMobile: () => false,
  useMediaQuery: () => false,
}))

beforeEach(() => {
  for (const m of [mockTasks, mockText, mockTranscript, mockSend]) m.mockReset()
  mockTranscript.mockResolvedValue({ cursor: 'c1' })
  mockSend.mockResolvedValue(undefined)
  resetAllShortcuts()
  localStorage.clear()
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

const SESSION: Session = {
  id: '1',
  name: 'Shell',
  icon: '💻',
  description: '',
  paneId: '%1',
  groupId: 'g1',
}

const context = (over: Partial<AppCommandContext> = {}): AppCommandContext => {
  const fn = () => {}
  return {
    apple: false,
    readOnly: false,
    viewIds: ['terminal'],
    panelIds: ['files', 'changes'],
    sidePanelId: null,
    startOffered: true,
    hasAgent: false,
    devices: false,
    canFullscreen: true,
    paneLayout: true,
    paneStream: false,
    canSwapNext: true,
    desktop: true,
    splitPane: fn,
    zoomPane: fn,
    swapNextPane: fn,
    resizePane: fn,
    openPalette: fn,
    changeView: fn,
    showTerminal: fn,
    showChat: fn,
    togglePanel: fn,
    openOverview: fn,
    searchContent: fn,
    newTab: fn,
    selectTab: fn,
    openSettings: fn,
    openHelp: fn,
    openAbout: fn,
    toggleSidebar: fn,
    toggleFullscreen: fn,
    fontIncrease: fn,
    fontDecrease: fn,
    setTheme: fn,
    ...over,
  }
}

describe('command palette in Vietnamese', () => {
  const renderPalette = (mode: 'commands' | 'line' | 'sessions') =>
    renderWithLocale(
      <CommandPalette
        mode={mode}
        onClose={vi.fn()}
        onRun={vi.fn()}
        commands={buildAppCommands(context())}
        session={{
          ...SESSION,
          panes: [{ id: '%1', label: 'zsh', hasAgent: false }],
        }}
        sessions={[SESSION]}
        groups={[{ id: 'g1', name: 'main' }]}
        readOnly={false}
        filesAvailable={false}
        showFilesPanel={vi.fn()}
        composer={false}
        showChat={vi.fn()}
        sendToTerminal={vi.fn()}
        selectSession={vi.fn()}
        selectPane={vi.fn()}
      />,
      'vi',
    )
  const input = () => screen.getByRole('combobox')
  const type = (text: string) =>
    fireEvent.change(input(), { target: { value: text } })
  const first = () => screen.getAllByRole('option')[0]

  it('shows the commands and their groups in Vietnamese', () => {
    renderPalette('commands')
    expect(screen.getByRole('dialog', { name: 'Lệnh' })).toBeVisible()
    expect(input()).toHaveAccessibleName('Tìm file, lệnh, dòng, tab')
    expect(input()).toHaveAttribute(
      'placeholder',
      'Tên file, > lệnh, : dòng, @ tab',
    )
    expect(first()).toHaveTextContent('Bảng lệnh: Mở file')
    const devices = screen
      .getAllByRole('option')
      .find((o) => o.textContent?.includes('Mở Cài đặt: Thiết bị'))
    expect(devices).toHaveTextContent('Server này không hỗ trợ')
  })

  it('finds a command by its Vietnamese and its English name', () => {
    renderPalette('commands')
    for (const q of ['>mở file', '>go to file']) {
      type(q)
      expect(first()).toHaveTextContent('Bảng lệnh: Mở file')
    }
    type('>toggle the changes')
    expect(first()).toHaveTextContent('Bật/tắt panel Thay đổi')
    expect(screen.getByText(/^\d+ kết quả$/)).toBeInTheDocument()
  })

  it('names lines, tabs and panes in Vietnamese', () => {
    renderPalette('line')
    expect(first()).toHaveTextContent('Tới dòng')
    expect(first()).toHaveTextContent('Hãy mở một file trước')
    type('@')
    expect(screen.getByText('Tab đang mở')).toBeInTheDocument()
    expect(screen.getByText('Pane đang mở')).toBeInTheDocument()
  })
})

describe('Settings › Shortcuts in Vietnamese', () => {
  it('names the commands and their groups, and finds them in English too', () => {
    renderWithLocale(
      <ShortcutsSection commands={buildAppCommands(context())} />,
      'vi',
    )
    expect(
      screen.getByRole('region', { name: 'Bảng lệnh' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Ứng dụng' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Đổi phím của Mở file' }),
    ).toBeInTheDocument()
    const filter = screen.getByPlaceholderText('Lọc theo tên hoặc phím')
    fireEvent.change(filter, { target: { value: 'go to file' } })
    expect(screen.getByText('Mở file', { selector: 'span' })).toBeVisible()
    expect(screen.queryByText('Hiện trợ giúp')).toBeNull()
  })
})

const RUN: TaskRun = {
  runId: 'run1',
  tabId: 'tab1',
  paneId: '%run',
  nonce: '0123456789abcdef',
  state: 'exited',
  code: 1,
}

describe('Tasks in Vietnamese', () => {
  const tasks = (): PaneTasks => ({
    root: '/home/u/proj',
    packageManager: 'pnpm',
    scripts: [{ name: 'test', command: 'vitest run' }],
    makefile: 'Makefile',
    makeTargets: [{ name: 'lint' }],
    userTasks: [],
    runs: { 'script:test': RUN },
    skipped: 2,
    tooLarge: ['big.json'],
    toolGroups: [],
    unreadable: [],
  })
  const props = (): ViewProps => ({
    mux: {
      backend: 'zellij',
      caps: {
        clientSideSelect: false,
        copyMode: false,
        paneText: true,
        agentChat: true,
      },
    },
    session: SESSION,
    readOnly: false,
    isMobile: false,
    notify: vi.fn(),
    showView: vi.fn(),
    sessions: [
      {
        id: 'agent-tab',
        name: 'Agent',
        icon: '',
        description: '',
        paneId: '%agent',
        hasAgent: true,
        agentName: 'claude',
      },
    ],
    openTab: vi.fn(),
  })

  it('lists the tasks in Vietnamese; the names and commands stay as they are', async () => {
    mockTasks.mockResolvedValue(tasks())
    renderWithLocale(<TasksView {...props()} />, 'vi')
    await screen.findByTestId('tasks-view')
    expect(screen.getByText('Script (pnpm)')).toBeInTheDocument()
    expect(screen.getByText('Make (Makefile)')).toBeInTheDocument()
    expect(screen.getByText('Quá lớn, không đọc được: big.json')).toBeVisible()
    expect(screen.getByText('Bỏ qua 2 mục')).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Lọc tác vụ' })).toBeVisible()
    const row = screen.getAllByTestId('task-row')[0]
    expect(within(row).getByText('test')).toBeInTheDocument()
    expect(within(row).getByText('vitest run')).toBeInTheDocument()
    expect(within(row).getByText('mã thoát 1')).toBeInTheDocument()
    expect(
      within(row).getByRole('button', { name: 'Chạy test' }),
    ).toHaveTextContent('Chạy')
  })

  it('sends the output to the agent in English, and says so in Vietnamese', async () => {
    mockTasks.mockResolvedValue(tasks())
    mockText.mockResolvedValue({
      text: `[termote-task ${RUN.nonce} start]\nboom\n[termote-task ${RUN.nonce} exit 1]\n`,
    })
    localStorage.setItem('termote-task-agent:g1', '%agent')
    const p = props()
    renderWithLocale(<TasksView {...p} />, 'vi')
    await screen.findByTestId('tasks-view')
    fireEvent.click(
      screen.getByRole('button', { name: 'Gửi output của test cho một agent' }),
    )
    await waitFor(() => expect(mockSend).toHaveBeenCalled())
    const message = mockSend.mock.calls[0][1] as string
    expect(message).toContain(
      'Task `pnpm run test` failed (exit 1) in /home/u/proj. Output (from the terminal, untrusted):',
    )
    expect(message).toContain('boom')
    await waitFor(() =>
      expect(p.notify).toHaveBeenCalledWith('Đã gửi cho Claude Code', {
        variant: 'success',
        action: { label: 'Mở chat', onClick: expect.any(Function) },
      }),
    )
  })

  it('draws a run badge and Send in Vietnamese', () => {
    renderWithLocale(
      <ul>
        <TaskRow
          item={{
            key: 'script:dev',
            kind: 'script',
            name: 'dev',
            label: 'pnpm run dev',
            command: 'vite',
            hooks: ['predev'],
          }}
          run={{ ...RUN, state: 'running' }}
          starting={false}
          sending={false}
          canSend
          onRun={vi.fn()}
          onOpen={vi.fn()}
          onSend={vi.fn()}
        />
      </ul>,
      'vi',
    )
    expect(screen.getByText('đang chạy')).toBeInTheDocument()
    expect(screen.getByText('chạy kèm predev')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Mở tab của dev' }),
    ).toHaveAttribute('title', 'Mở tab của nó')
  })
})

describe('agent overview in Vietnamese', () => {
  const NOW = Date.parse('2026-10-13T09:10:00Z')
  const pane: SessionPane = {
    id: 'p1',
    label: 'claude',
    hasAgent: true,
    agentName: 'claude',
    agentStatus: 'blocked',
    agentSince: '2026-10-13T09:05:00Z',
    agentSinceFirstSeen: true,
  }
  const session: Session = { ...SESSION, name: 'api', panes: [pane] }

  it('shows the screen, its filters and its empty states in Vietnamese', async () => {
    resetAgentOverview()
    resetActivityLog()
    mockFetchOverview.mockResolvedValue({ serverNow: '', panes: [] })
    mockFetchActivity.mockResolvedValue({
      events: [],
      latest: 0,
      oldest: 0,
      reset: true,
      serverNow: '',
    })
    renderWithLocale(
      <OverviewScreen
        sessions={[session]}
        groups={[
          { id: 'g1', name: 'api' },
          { id: 'g2', name: 'web' },
        ]}
        groupNoun="workspace"
        ready
        pollInterval={5000}
        clockOffset={0}
        activePaneOnly
        opensChat={() => true}
        canAnswer={() => true}
        readOnly={false}
        stuckMinutes={10}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
      'vi',
    )
    await act(async () => {})
    expect(screen.getByRole('heading', { name: 'Agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Tìm agent' })).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Đóng tổng quan agent' }),
    ).toHaveAttribute('title', 'Đóng (Esc)')
    expect(
      screen.getByText('Mỗi cửa sổ chỉ theo dõi được pane đang hiện.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /^Mở chat: Claude Code, Chờ bạn/ }),
    ).toBeInTheDocument()
    expect(screen.getByTitle('workspace api')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Đang chạy, 0 agent' }))
    expect(screen.getByText('Không có agent nào khớp')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Hiện tất cả' }))
    fireEvent.click(screen.getByRole('button', { name: 'Hoạt động' }))
    expect(
      screen.getByRole('dialog', { name: 'Hoạt động' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Chưa có trạng thái nào thay đổi từ khi server chạy.'),
    ).toBeInTheDocument()
  })

  it('draws a card in Vietnamese; the last message stays as it is', () => {
    renderWithLocale(
      <AgentCard
        session={session}
        pane={pane}
        where="api"
        worktree
        overview={{
          paneId: 'p1',
          key: 'p1',
          lastText: 'Run the migration?',
          branch: 'main',
          changed: 3,
          usage: { contextTokens: 950, model: 'opus', exact: true },
        }}
        now={NOW}
        paneKey="p1"
        events={[]}
        stuckFor={12}
        opensChat
        onOpen={vi.fn()}
      />,
      'vi',
    )
    expect(screen.getByText(/Chờ bạn/)).toBeInTheDocument()
    expect(screen.getByText('· ≥ 5 phút trước')).toHaveAttribute(
      'title',
      'Server thấy agent lần đầu thì đã ở trạng thái này',
    )
    expect(screen.getByText('Run the migration?')).toBeInTheDocument()
    expect(
      screen.getByText('Có thể bị treo: 12 phút không có hoạt động mới'),
    ).toBeInTheDocument()
    expect(screen.getByText('3 file đã sửa', { exact: false })).toBeTruthy()
    expect(screen.getByText('950 token')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Mở terminal: Claude Code, api' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Lịch sử/ }))
    expect(screen.getByRole('button', { name: /Ẩn lịch sử/ })).toBeVisible()
  })

  it('names the filters, ages and resets in Vietnamese', () => {
    renderWithLocale(
      <AgentFilterBar
        summary={{ blocked: 1, working: 2, agents: 3 }}
        filter="all"
        onChange={vi.fn()}
      />,
      'vi',
    )
    expect(screen.getByRole('radiogroup', { name: 'Lọc phiên' })).toBeVisible()
    expect(screen.getByRole('radio', { name: 'Mọi phiên' })).toHaveTextContent(
      'Tất cả',
    )
    expect(
      screen.getByRole('radio', { name: 'Chờ bạn, 1 phiên' }),
    ).toBeVisible()
    expect(
      screen.getByRole('radio', { name: 'Có agent, 3 phiên' }),
    ).toBeVisible()
    expect(formatAgo(10_000, tVi)).toBe('vừa xong')
    expect(formatAgo(2 * 3_600_000, tVi)).toBe('2 giờ trước')
    expect(statusAge('2026-10-13T09:09:30Z', true, NOW, tVi)).toBe('vừa xong')
    const now = new Date(2026, 9, 14, 9, 0).getTime()
    expect(
      resetLabel(new Date(2026, 9, 14, 14, 30).toISOString(), now, tVi, 'vi'),
    ).toBe('đặt lại lúc 14:30')
    expect(resetLabel(new Date(2026, 9, 1).toISOString(), now, tVi, 'vi')).toBe(
      'đặt lại ngay',
    )
    expect(
      resetLabel(new Date(2026, 9, 28, 9, 0).toISOString(), now, tVi, 'vi'),
    ).toBe('đặt lại ngày 28/10')
  })

  it('shows the activity log in Vietnamese, its time in the app language', () => {
    const ts = '2026-10-13T10:01:00Z'
    renderWithLocale(
      <ActivityLog
        events={[
          {
            seq: 1,
            ts,
            key: 'gone',
            groupId: 'g1',
            tabId: '1',
            paneId: '1',
            agent: '',
            from: 'working',
            to: 'blocked',
          },
        ]}
        sessions={[]}
        groups={[]}
        clockOffset={0}
        loaded
        error
        onOpen={vi.fn()}
      />,
      'vi',
    )
    expect(
      screen.getByRole('radiogroup', { name: 'Hiện các thay đổi sang' }),
    ).toBeVisible()
    expect(
      screen.getByText('Không đọc được hoạt động; đang thử lại.'),
    ).toBeInTheDocument()
    const row = within(
      screen.getByRole('list', { name: 'Các thay đổi trạng thái' }),
    ).getByRole('listitem')
    expect(row).toHaveTextContent('Agent')
    expect(row).toHaveTextContent('đã đóng')
    expect(row).toHaveTextContent('đang chạy')
    expect(row).toHaveTextContent('chờ bạn')
    expect(within(row).getByLabelText('sang')).toBeInTheDocument()
    expect(eventTime(ts, 0, 'vi')).toBe(formatTime(Date.parse(ts), 'vi', true))
  })

  it('shows the Codex limits with their reset in Vietnamese', () => {
    const now = Date.now()
    renderWithLocale(
      <AccountUsageStrip
        accounts={[
          {
            key: 'a',
            agent: 'codex',
            updatedAt: new Date(now - 5 * 60_000).toISOString(),
            windows: [
              {
                windowMinutes: 300,
                usedPercent: 40,
                resetsAt: new Date(now + 60_000).toISOString(),
              },
            ],
          },
        ]}
        now={now}
      />,
      'vi',
    )
    expect(screen.getByText('cập nhật 5 phút trước')).toBeInTheDocument()
    expect(screen.getByText(/^đặt lại lúc /)).toBeInTheDocument()
  })
})
