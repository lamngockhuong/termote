import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewProps } from '../app-views'
import { AgentPanePicker } from '../components/agent-pane-picker'
import { ChatComposer } from '../components/chat-composer'
import { ChatInput } from '../components/chat-input'
import { ChatMessage } from '../components/chat-message'
import { runSummary, stepLine } from '../components/chat-tool-run'
import { NeedsMeQueue, type QueueCard } from '../components/needs-me-queue'
import { PromptCard, WaitingCard } from '../components/prompt-card'
import { StartAgentPanel } from '../components/start-agent-panel'
import {
  SubagentTree,
  subagentDuration,
  subagentSummary,
} from '../components/subagent-tree'
import { TemplateFillDialog } from '../components/template-fill-dialog'
import { TemplatePicker } from '../components/template-picker'
import { resetChatAttachments } from '../hooks/use-chat-attachments'
import {
  type AgentCommand,
  type AgentPrompt,
  AgentRequestError,
  type PromptTemplate,
  type SubagentNode,
  type TranscriptEntry,
} from '../hooks/use-mux-api'
import type { Session, SessionPane } from '../types/session'
import { takeDraftInsert } from '../utils/chat-draft'
import { diffLines, diffSummary } from '../utils/line-diff'
import type { TemplateValues } from '../utils/resolve-template-vars'
import {
  CLAUDE_BUILTIN_COMMANDS,
  commandDescription,
  filterSlashCommands,
} from '../utils/slash-commands'
import { requestTemplateFill } from '../utils/template-fill-request'
import { formatDateTime, formatTime } from './format'
import { tFor } from './i18n-context'
import { renderWithLocale } from './test-utils'

// The Chat view in Vietnamese: its own words are translated, while what the
// user and the agent wrote, the tools' input and output, the command names
// and whatever goes to the agent stay as they are
const tVi = tFor('vi')

const transcript = {
  cursor: 'cur1' as string | undefined,
  status: 'idle' as string | undefined,
  refresh: vi.fn(),
}
const promptStore = {
  loaded: true,
  prompt: null as AgentPrompt | null,
  refresh: vi.fn(),
  show: vi.fn(),
}
vi.mock('../hooks/use-agent-prompt', () => ({
  useAgentPrompt: () => promptStore,
}))
vi.mock('../hooks/use-agent-transcript', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-agent-transcript')>()),
  useAgentTranscript: () => ({
    entries: [],
    loaded: true,
    loadingOlder: false,
    cursor: transcript.cursor,
    status: transcript.status,
    refresh: transcript.refresh,
    loadOlder: vi.fn(),
  }),
}))
const commandsStore = { list: [] as AgentCommand[] }
vi.mock('../hooks/use-agent-commands', () => ({
  useAgentCommands: () => commandsStore.list,
}))
const templates = vi.hoisted(() => ({
  list: [] as PromptTemplate[],
  refresh: vi.fn(async () => {}),
}))
vi.mock('../hooks/use-prompt-templates', () => ({
  usePromptTemplates: () => ({
    templates: templates.list,
    readOnly: false,
    loaded: true,
    loading: false,
    error: false,
    refresh: templates.refresh,
  }),
  templateById: (id: string) => templates.list.find((t) => t.id === id) ?? null,
  refreshTemplates: templates.refresh,
}))
const vars = vi.hoisted(() => ({
  known: {} as Required<TemplateValues>,
}))
vi.mock('../utils/resolve-template-vars', () => ({
  knownTemplateValues: () => vars.known,
  fetchBranch: async () => 'main',
}))
const mockSend = vi.fn()
const mockAnswer = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  sendAgentMessage: (...a: unknown[]) => mockSend(...a),
  answerAgentPrompt: (...a: unknown[]) => mockAnswer(...a),
}))

const showView = vi.fn()
const props = (over: Partial<ViewProps> = {}): ViewProps => ({
  mux: {
    backend: 'tmux',
    caps: {
      clientSideSelect: false,
      copyMode: true,
      agentChat: true,
      templates: true,
    },
  },
  session: {
    id: '0',
    name: 'claude',
    icon: '',
    description: '',
    paneId: '%3',
    hasAgent: true,
    agentName: 'claude',
  },
  readOnly: false,
  isMobile: false,
  notify: vi.fn(),
  showView,
  ...over,
})

beforeEach(() => {
  resetChatAttachments()
  vi.clearAllMocks()
  sessionStorage.clear()
  promptStore.prompt = null
  commandsStore.list = []
  templates.list = []
  mockSend.mockResolvedValue({ queued: false })
  mockAnswer.mockResolvedValue(undefined)
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the conversation in Vietnamese', () => {
  it('keeps what the user, the agent and the tools wrote', () => {
    const ts = '2026-10-08T09:39:00Z'
    const user: TranscriptEntry = {
      id: 'u',
      role: 'user',
      ts,
      parts: [
        { kind: 'text', text: 'Run the tests, please' },
        { kind: 'image' },
      ],
    }
    const agent: TranscriptEntry = {
      id: 'a',
      role: 'assistant',
      ts,
      parts: [
        { kind: 'thinking', text: 'The suite is in pwa/' },
        {
          kind: 'tool',
          tool: 'Bash',
          input: 'pnpm test',
          detail: { command: 'pnpm test' },
          result: 'one\ntwo\nthree',
        },
        { kind: 'text', text: 'All **tests** passed.' },
      ],
    }
    const { container } = renderWithLocale(
      <>
        <ChatMessage entry={user} showTime />
        <ChatMessage entry={agent} />
      </>,
      'vi',
    )
    expect(screen.getByText('Run the tests, please')).toBeInTheDocument()
    expect(screen.getAllByText('[ảnh]')).toHaveLength(1)
    const time = container.querySelector('time')!
    expect(time).toHaveTextContent(formatTime(new Date(ts), 'vi'))
    expect(time).toHaveAttribute('title', formatDateTime(new Date(ts), 'vi'))

    expect(screen.getByText('Suy nghĩ')).toBeInTheDocument()
    expect(screen.getByText('The suite is in pwa/')).toBeInTheDocument()
    expect(container.querySelector('[data-tool="Bash"]')).toHaveTextContent(
      'Bash',
    )
    expect(container).toHaveTextContent('$ pnpm test')
    fireEvent.click(screen.getByRole('button', { name: 'Output · 3 dòng' }))
    expect(container).toHaveTextContent('one two three')
    expect(screen.getByRole('button', { name: 'Ẩn output' })).toBeVisible()
    expect(container.querySelector('strong')).toHaveTextContent('tests')
    expect(
      screen.getByRole('button', { name: 'Sao chép câu trả lời' }),
    ).toBeInTheDocument()
  })

  it('a result whose call came earlier keeps its English data-tool', () => {
    const { container } = renderWithLocale(
      <ChatMessage
        entry={{
          id: 'r',
          role: 'assistant',
          parts: [{ kind: 'tool', orphan: true, result: 'ok' }],
        }}
      />,
      'vi',
    )
    expect(container.querySelector('[data-tool="Result"]')).toHaveTextContent(
      'Kết quả',
    )
    expect(
      screen.getByText('Lệnh gọi nằm ở phần trước của cuộc trò chuyện.'),
    ).toBeInTheDocument()
  })

  it('says what a run of steps and an edit did', () => {
    const parts = [
      { kind: 'tool' as const, tool: 'Bash' },
      { kind: 'tool' as const, tool: 'Bash' },
      { kind: 'tool' as const, tool: 'Edit' },
      { kind: 'tool' as const, tool: 'Grep' },
    ]
    expect(runSummary(parts, tVi)).toBe('2 lệnh, 1 lần sửa, 1 lần tìm')
    expect(stepLine({ kind: 'tool', tool: 'Read', input: 'x.ts' }, tVi)).toBe(
      'Read x.ts',
    )
    expect(stepLine({ kind: 'tool', orphan: true }, tVi)).toBe('Kết quả')
    expect(diffSummary(diffLines('a', 'a\nb'), tVi)).toBe('Thêm 1 dòng')
    expect(diffSummary(diffLines('a\nb\nc', 'a'), tVi)).toBe('Xóa 2 dòng')
  })

  it('names subagents in Vietnamese, their types as the agent wrote them', () => {
    const node = (over: Partial<SubagentNode>): SubagentNode => ({
      id: 'n',
      type: 'code-reviewer',
      depth: 1,
      status: 'running',
      children: [],
      ...over,
    })
    const nodes = [
      node({ id: 'a', startTs: '2026-10-08T09:00:00Z' }),
      node({ id: 'b', status: 'done', type: 'Explore' }),
    ]
    const now = Date.parse('2026-10-08T09:03:00Z')
    expect(subagentSummary({ nodes }, tVi)).toBe('2 subagent, 1 đang chạy')
    expect(subagentDuration(nodes[0], now, tVi)).toBe('3 phút')
    renderWithLocale(
      <SubagentTree tree={{ nodes }} error={false} now={now} />,
      'vi',
    )
    expect(screen.getByRole('list', { name: 'Subagent' })).toBeInTheDocument()
    expect(screen.getByText('code-reviewer')).toBeInTheDocument()
    expect(screen.getByText(/· đang chạy · 3 phút/)).toBeInTheDocument()
  })
})

describe('the input area in Vietnamese', () => {
  it('an agent the server cannot write to is read only', () => {
    const p = props()
    renderWithLocale(
      <ChatInput {...p} session={{ ...p.session, agentName: 'copilot' }} />,
      'vi',
    )
    expect(screen.getByText('Chỉ đọc')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

describe('the composer in Vietnamese', () => {
  const box = () =>
    screen.getByRole('textbox', { name: 'Tin nhắn gửi Claude Code' })

  it('labels its controls and sends the text as typed', async () => {
    renderWithLocale(<ChatComposer {...props()} />, 'vi')
    expect(box()).toHaveAttribute('placeholder', 'Tin nhắn')
    expect(screen.getByRole('button', { name: 'Mẫu' })).toBeInTheDocument()
    expect(screen.getByText('Ctrl+Enter để gửi')).toBeInTheDocument()
    fireEvent.change(box(), { target: { value: 'chạy test giúp tôi' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gửi' }))
    })
    expect(mockSend).toHaveBeenCalledWith(
      '%3',
      'chạy test giúp tôi',
      'cur1',
      [],
      [],
    )
  })

  it('finds a built-in by its Vietnamese description and sends its English name', async () => {
    commandsStore.list = [
      {
        name: 'ship',
        description: 'Ship it',
        source: 'project',
        kind: 'command',
      },
    ]
    renderWithLocale(<ChatComposer {...props()} />, 'vi')
    fireEvent.change(box(), { target: { value: '/' } })
    const list = screen.getByRole('listbox', { name: 'Lệnh' })
    // The agent's own description is shown as it wrote it
    expect(list).toHaveTextContent('Ship it')
    fireEvent.change(box(), { target: { value: '/giải phóng' } })
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.change(box(), { target: { value: '/tóm' } })
    expect(screen.getByRole('listbox', { name: 'Lệnh' })).toHaveTextContent(
      '/compactTóm tắt cuộc trò chuyện để giải phóng ngữ cảnhcó sẵn',
    )
    fireEvent.keyDown(box(), { key: 'Enter' })
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    })
    expect(mockSend).toHaveBeenCalledWith('%3', '/compact ', 'cur1', [], [])
  })

  it('says why a message was refused, by its code', async () => {
    mockSend.mockRejectedValue(
      new AgentRequestError(409, 'input_not_ready', 'a dialog is open'),
    )
    renderWithLocale(<ChatComposer {...props()} />, 'vi')
    fireEvent.change(box(), { target: { value: 'xin chào' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gửi' }))
    })
    expect(
      screen.getAllByText(
        'Chưa gửi: Lúc này agent chưa nhận được nội dung nhập.',
      ).length,
    ).toBeGreaterThan(0)
  })

  it('asks before ending the agent with /exit', async () => {
    renderWithLocale(<ChatComposer {...props()} />, 'vi')
    fireEvent.change(box(), { target: { value: '/exit' } })
    fireEvent.keyDown(box(), { key: 'Escape' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gửi' }))
    })
    expect(
      screen.getByRole('dialog', { name: 'Thoát Claude Code?' }),
    ).toHaveTextContent('Agent trong pane này sẽ dừng; app quay về terminal.')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Thoát' }))
    })
    expect(mockSend).toHaveBeenCalledWith('%3', '/exit', 'cur1', [], [])
  })
})

describe('a dialog the agent asks, in Vietnamese', () => {
  const prompt: AgentPrompt = {
    kind: 'select',
    promptId: 'p1',
    title: 'Do you want to proceed?',
    options: [
      { index: 1, label: 'Yes' },
      { index: 2, label: 'No, and tell Claude what to do differently' },
    ],
    freeText: { index: 3, label: 'Type something.' },
  }

  it("keeps the agent's words and answers with its choices", async () => {
    renderWithLocale(
      <PromptCard
        paneId="%3"
        prompt={prompt}
        showView={showView}
        onAnswered={vi.fn()}
        onChanged={vi.fn()}
      />,
      'vi',
    )
    expect(screen.getByRole('alertdialog')).toHaveAccessibleName(
      'Do you want to proceed?',
    )
    // A refusal is still told apart by Claude Code's English label
    const no = screen.getByRole('button', { name: /No, and tell/ })
    expect(no.className).toContain('danger')
    expect(screen.getByRole('button', { name: 'Hủy (Esc)' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /Khác…/ }))
    fireEvent.change(screen.getByLabelText('Câu trả lời của bạn'), {
      target: { value: 'dùng pnpm' },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gửi' }))
    })
    expect(mockAnswer).toHaveBeenCalledWith('%3', 'p1', { text: 'dùng pnpm' })
  })

  it('a dialog with no title says who asks; a wait points to the terminal', () => {
    renderWithLocale(
      <>
        <PromptCard
          paneId="%3"
          agentName="codex"
          prompt={{ kind: 'unsupported', title: '' }}
          showView={showView}
          onAnswered={vi.fn()}
          onChanged={vi.fn()}
        />
        <WaitingCard agentName="claude" showView={showView} />
      </>,
      'vi',
    )
    expect(screen.getByText('Codex đang hỏi')).toBeInTheDocument()
    expect(
      screen.getByText('Hãy trả lời hộp thoại này trong terminal.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Claude Code đang chờ bạn trong terminal.'),
    ).toBeInTheDocument()
  })
})

describe('the needs-me queue in Vietnamese', () => {
  it('names the agent and where it waits, as the user named it', () => {
    const pane: SessionPane = {
      id: '%1',
      label: 'api',
      hasAgent: true,
      agentName: 'claude',
      agentStatus: 'blocked',
      agentSince: '2026-10-08T09:00:00Z',
    }
    const session = { id: '0', name: 'web' } as Session
    const cards: QueueCard[] = [{ session, pane, where: 'web / api' }]
    renderWithLocale(
      <NeedsMeQueue
        cards={cards}
        readOnly={false}
        canAnswer={() => false}
        onOpen={vi.fn()}
      />,
      'vi',
    )
    expect(
      screen.getByRole('heading', { name: 'Cần bạn: Claude Code, web / api' }),
    ).toBeInTheDocument()
    expect(screen.getByText('cuối cùng')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Bỏ qua' }))
    expect(
      screen.getByText(/1 hộp thoại đã bỏ qua vẫn đang chờ\./),
    ).toBeInTheDocument()
  })
})

describe('templates in Vietnamese', () => {
  it('the picker lists templates by the names the user gave', () => {
    templates.list = [
      { id: 't1', name: 'Review PR', text: 'Review {{branch}}', updated: 'u' },
    ]
    renderWithLocale(
      <TemplatePicker
        isOpen
        onClose={vi.fn()}
        onPick={vi.fn()}
        onManage={vi.fn()}
      />,
      'vi',
    )
    expect(screen.getByRole('dialog', { name: 'Chèn mẫu' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Tìm mẫu' })).toBeVisible()
    expect(screen.getByRole('listbox', { name: 'Mẫu' })).toHaveTextContent(
      'Review PRReview {{branch}}',
    )
    expect(screen.getByRole('button', { name: 'Quản lý mẫu…' })).toBeVisible()
  })

  it('fills a template and inserts its text unchanged', () => {
    templates.list = [
      {
        id: 'full',
        name: 'Review',
        text: 'Review {{file}}: {{input}}',
        updated: 'u',
      },
    ]
    const none = { value: '', source: '' }
    vars.known = {
      file: { value: 'src/a.ts', source: 'chat.fill.from.file' },
      selection: none,
      branch: none,
      input: none,
    }
    renderWithLocale(
      <TemplateFillDialog
        pane={() => ({ agent: 'claude' })}
        terminalText={() => ''}
        notify={vi.fn()}
      />,
      'vi',
    )
    act(() =>
      requestTemplateFill({ paneId: '1', templateId: 'full', agent: 'claude' }),
    )
    expect(screen.getByRole('dialog', { name: 'Chèn Review' })).toBeVisible()
    expect(screen.getByText('Lấy từ file đang mở')).toBeInTheDocument()
    expect(screen.getByText('1 KB / 16 KB')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/Nội dung bạn nhập/), {
      target: { value: 'ngắn gọn' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Chèn' }))
    expect(takeDraftInsert('1', 'claude')).toEqual({
      text: 'Review src/a.ts: ngắn gọn',
      at: undefined,
    })
  })
})

describe('built-in commands in Vietnamese', () => {
  it("describes a built-in in Vietnamese and an agent's command as it wrote it", () => {
    const compact = CLAUDE_BUILTIN_COMMANDS.find((c) => c.name === 'compact')!
    expect(commandDescription(compact, tVi)).toBe(
      'Tóm tắt cuộc trò chuyện để giải phóng ngữ cảnh',
    )
    const own = {
      name: 'ship',
      description: 'Ship it',
      source: 'user' as const,
    }
    expect(commandDescription(own, tVi)).toBe('Ship it')
    expect(
      filterSlashCommands([compact, own], 'ngữ cảnh', tVi).map((c) => c.name),
    ).toEqual(['compact'])
    // The agent's English words still find it
    expect(
      filterSlashCommands([compact, own], 'free up', tVi).map((c) => c.name),
    ).toEqual(['compact'])
  })
})

describe('picking an agent and starting one, in Vietnamese', () => {
  it('lists the panes by the names the user gave', () => {
    renderWithLocale(
      <AgentPanePicker
        isOpen
        choices={[
          {
            sessionId: '0',
            paneId: '%1',
            label: 'web · api',
            agentName: 'codex',
          },
        ]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
      'vi',
    )
    expect(
      screen.getByRole('dialog', { name: 'Gửi cho agent nào?' }),
    ).toHaveTextContent('web · apiCodex')
  })

  it('offers the agents by their names', () => {
    renderWithLocale(
      <StartAgentPanel
        kinds={['claude', 'codex']}
        record={{ kind: 'codex', phase: 'starting', since: 1 }}
        onStart={vi.fn()}
      />,
      'vi',
    )
    expect(
      screen.getByText('Khởi động một agent trong pane này'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Claude Code' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Đang khởi động Codex…',
    )
  })
})
