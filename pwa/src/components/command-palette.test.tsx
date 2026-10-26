import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetFilesStores, useFiles } from '../hooks/use-files'
import { type FindResponse, RequestError } from '../hooks/use-mux-api'
import { resetAllShortcuts, setShortcut } from '../hooks/use-shortcuts'
import type { Session, SessionPane } from '../types/session'
import type { AppCommand } from '../utils/app-commands'
import { takeDraftInsert } from '../utils/chat-draft'
import { flushAll as flushKept } from '../utils/files-persist'
import { remapPanes } from '../utils/pane-remap'
import {
  onTemplateFill,
  type TemplateFill,
  takeTemplateFill,
} from '../utils/template-fill-request'
import { CommandPalette, type CommandPaletteProps } from './command-palette'

const platform = vi.hoisted(() => ({ apple: false }))
vi.mock('../utils/platform', () => ({
  isApplePlatform: () => platform.apple,
}))
vi.mock('../hooks/use-media-query', () => ({
  useIsMobile: () => false,
  useMediaQuery: () => false,
}))

const mockFind = vi.fn()
const mockTree = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  findFiles: (...a: unknown[]) => mockFind(...a),
  fetchFilesTree: (...a: unknown[]) => mockTree(...a),
}))

const agent = vi.hoisted(() => ({
  list: [] as { name: string; source: string; kind: string }[],
  enabled: false,
}))
const prompts = vi.hoisted(() => ({
  templates: [] as {
    id: string
    name: string
    text: string
    updated: string
  }[],
  refresh: vi.fn(async () => {}),
}))
vi.mock('../hooks/use-prompt-templates', () => ({
  usePromptTemplates: () => ({
    templates: prompts.templates,
    readOnly: false,
    loaded: true,
    loading: false,
    error: false,
    refresh: prompts.refresh,
  }),
}))
vi.mock('../hooks/use-agent-commands', () => ({
  useAgentCommands: (_p: string, enabled: boolean) => {
    agent.enabled = enabled
    return agent.list
  },
}))

const found = (paths: string[], root = '/r'): FindResponse => ({
  root,
  isRepo: true,
  results: paths.map((path) => ({
    path,
    sensitive: path.endsWith('.env'),
    ignored: false,
  })),
  truncated: false,
  incomplete: false,
})

const SESSION: Session = {
  id: '1',
  name: 'Shell',
  icon: '💻',
  description: '',
  paneId: '%1',
  groupId: 'g1',
}

function commands(): AppCommand[] {
  return [
    {
      id: 'palette.quickOpen',
      title: 'Go to file',
      category: 'Palette',
      defaultKey: 'Mod+P',
      run: vi.fn(),
    },
    {
      id: 'palette.commands',
      title: 'Show all commands',
      category: 'Palette',
      defaultKey: 'Mod+Shift+P',
      run: vi.fn(),
    },
    {
      id: 'palette.goToLine',
      title: 'Go to line',
      category: 'Palette',
      run: vi.fn(),
    },
    {
      id: 'palette.sessions',
      title: 'Go to tab or pane',
      category: 'Palette',
      run: vi.fn(),
    },
    {
      id: 'view.filesPanel',
      title: 'Toggle the Files panel',
      category: 'View',
      restoreFocus: true,
      run: vi.fn(),
    },
    {
      id: 'settings.devices',
      title: 'Open Settings: Devices',
      category: 'App',
      disabledReason: 'Not available on this server',
      run: vi.fn(),
    },
    {
      id: 'app.help',
      title: 'Show help',
      category: 'App',
      defaultKey: 'F1',
      run: vi.fn(),
    },
  ]
}

function renderPalette(over: Partial<CommandPaletteProps> = {}) {
  const props: CommandPaletteProps = {
    mode: 'files',
    onClose: vi.fn(),
    onRun: vi.fn((fn: () => void) => fn()),
    commands: commands(),
    session: SESSION,
    sessions: [
      SESSION,
      { ...SESSION, id: '2', name: 'Logs', icon: '📜', paneId: '%2' },
      {
        ...SESSION,
        id: '3',
        name: 'evil‮exe',
        icon: '🐚',
        groupId: 'g2',
        paneId: '%3',
      },
    ],
    groups: [
      { id: 'g1', name: 'main' },
      { id: 'g2', name: 'other' },
    ],
    readOnly: false,
    filesAvailable: true,
    showFilesPanel: vi.fn(),
    composer: false,
    showChat: vi.fn(),
    sendToTerminal: vi.fn(),
    selectSession: vi.fn(),
    ...over,
  }
  const view = render(<CommandPalette {...props} />)
  return { ...props, ...view }
}

const input = () => screen.getByRole('combobox')
const options = () => screen.queryAllByRole('option')
const type = (text: string) =>
  fireEvent.change(input(), { target: { value: text } })
const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(input(), { key: k, ...init })

// The pane's Files store, loaded on root /r
async function filesStore() {
  const hook = renderHook(() => useFiles('%1'))
  act(() => hook.result.current.load())
  await waitFor(() => expect(hook.result.current.root).toBe('/r'))
  return hook
}

beforeEach(() => {
  platform.apple = false
  agent.list = []
  resetFilesStores()
  resetAllShortcuts()
  mockFind.mockReset()
  mockTree.mockReset()
  mockTree.mockImplementation(
    async (_p: string, path: string, root?: string) => ({
      root: root ?? '/r',
      isRepo: true,
      path,
      entries: [],
      truncated: false,
    }),
  )
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  takeDraftInsert('%1')
})

describe('CommandPalette', () => {
  it('opens on its input, a combobox driving the list', async () => {
    await filesStore().then(({ result }) => {
      act(() => result.current.open('a.md'))
      act(() => result.current.open('b.md'))
    })
    renderPalette()
    expect(input()).toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'Go to file' })).toBeVisible()
    const list = screen.getByRole('listbox')
    expect(input()).toHaveAttribute('aria-controls', list.id)
    expect(input()).toHaveAttribute('aria-expanded', 'true')
    expect(input()).toHaveAttribute('aria-activedescendant', options()[0].id)
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('1 result')).toBeInTheDocument()
  })

  describe('files', () => {
    it('lists the files opened lately but the one shown, then open tabs', async () => {
      const { result } = await filesStore()
      act(() => result.current.open('docs/a.md', { pin: true }))
      act(() => result.current.open('b.md', { pin: true }))
      act(() => result.current.open('c.md', { pin: true }))
      // A tab that is not in the list (restored, created)
      await act(() => result.current.created('new.md', '/r', false))
      act(() => result.current.activate(result.current.tabs[0].id))
      const p = renderPalette()
      expect(options().map((o) => o.textContent)).toEqual([
        'c.md',
        'b.md',
        'new.md',
      ])
      // Back to the file before: Enter
      key('Enter')
      expect(p.onRun).toHaveBeenCalledOnce()
      expect(result.current.active?.path).toBe('c.md')
      expect(p.showFilesPanel).toHaveBeenCalled()
      // A tab opens from its row
      renderPalette()
      fireEvent.click(screen.getAllByRole('option', { name: /new\.md/ })[0])
      expect(result.current.active?.path).toBe('new.md')
    })

    it('reads the root on open, and lists no file of another root', async () => {
      const { result } = await filesStore()
      act(() => result.current.open('old.md'))
      // The app opens again on a pane that moved: the store starts over
      flushKept()
      resetFilesStores()
      mockTree.mockClear()
      renderPalette()
      expect(mockTree).toHaveBeenCalledWith('%1', '', undefined)
      expect(options()).toHaveLength(0)
    })

    it('forgets an early Enter once the query changes', async () => {
      let answer: (r: FindResponse) => void = () => {}
      mockFind.mockImplementation(
        () => new Promise<FindResponse>((r) => (answer = r)),
      )
      const p = renderPalette()
      type('ab')
      key('Enter')
      type('abc')
      await act(async () => answer(found(['ab.md'])))
      expect(p.onRun).not.toHaveBeenCalled()
    })

    it('leaves Enter to an IME composition', () => {
      const p = renderPalette({ mode: 'commands' })
      type('>help')
      fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
      expect(p.onRun).not.toHaveBeenCalled()
    })

    it('says what to do when nothing was opened yet', () => {
      renderPalette()
      expect(screen.getByText('Type a file name')).toBeInTheDocument()
      expect(input()).toHaveAttribute('aria-expanded', 'false')
      expect(input()).not.toHaveAttribute('aria-activedescendant')
      key('Enter')
    })

    it('finds files after the pause, files opened lately first, and opens one', async () => {
      const { result } = await filesStore()
      act(() => result.current.open('src/b.ts'))
      mockFind.mockResolvedValue(found(['src/a.ts', 'src/b.ts', '.env']))
      const p = renderPalette()
      type('ts')
      expect(mockFind).not.toHaveBeenCalled()
      await waitFor(() => expect(options()).toHaveLength(3))
      expect(mockFind).toHaveBeenCalledWith(
        '%1',
        { q: 'ts', root: '/r', ignored: false, exclude: expect.any(Array) },
        expect.any(AbortSignal),
      )
      expect(options().map((o) => o.textContent)).toEqual([
        'b.tssrc/',
        'a.tssrc/',
        '.envSensitive',
      ])
      key('ArrowDown')
      key('Enter', { ctrlKey: true })
      expect(p.onRun).toHaveBeenCalledOnce()
      expect(result.current.active).toMatchObject({
        path: 'src/a.ts',
        pinned: true,
      })
    })

    it('opens the first result of what was typed when Enter comes first', async () => {
      const { result } = await filesStore()
      let answer: (r: FindResponse) => void = () => {}
      mockFind.mockImplementation(
        () => new Promise<FindResponse>((r) => (answer = r)),
      )
      const p = renderPalette()
      type('ab')
      key('Enter')
      // Sent at once, not after the pause
      await waitFor(() => expect(mockFind).toHaveBeenCalledOnce())
      expect(p.onRun).not.toHaveBeenCalled()
      await act(async () => answer(found(['x/ab.md'])))
      expect(p.onRun).toHaveBeenCalledOnce()
      expect(result.current.active?.path).toBe('x/ab.md')
    })

    it('opens nothing when the early Enter finds nothing', async () => {
      mockFind.mockResolvedValue(found([]))
      const p = renderPalette()
      type('zz')
      key('Enter')
      await screen.findByText('No files match')
      expect(p.onRun).not.toHaveBeenCalled()
    })

    it('reads the root first when the store has not, and opens under the result root', async () => {
      mockFind.mockResolvedValue(found(['a.md'], '/elsewhere'))
      renderPalette()
      type('a')
      await waitFor(() => expect(options()).toHaveLength(1))
      expect(mockTree).toHaveBeenCalledWith('%1', '', undefined)
      key('Enter')
      const store = renderHook(() => useFiles('%1')).result
      expect(store.current.active).toMatchObject({
        root: '/elsewhere',
        path: 'a.md',
      })
    })

    it('searches again when the root moved', async () => {
      await filesStore()
      mockFind
        .mockRejectedValueOnce(
          new RequestError(409, '', 'moved', { root: '/new' }),
        )
        .mockResolvedValueOnce(found(['a.md'], '/new'))
      renderPalette()
      type('a')
      await waitFor(() => expect(options()).toHaveLength(1))
      expect(mockFind).toHaveBeenLastCalledWith(
        '%1',
        expect.objectContaining({ root: '/new' }),
        expect.any(AbortSignal),
      )
    })

    it('says why a search failed', async () => {
      mockFind.mockRejectedValue(new RequestError(403, '', 'nope'))
      renderPalette()
      type('a')
      expect(
        await screen.findByText("This directory can't be searched"),
      ).toBeInTheDocument()
      expect(input()).toHaveAttribute('aria-describedby')
    })

    it('says it is searching only once the search is slow', async () => {
      vi.useFakeTimers()
      mockFind.mockImplementation(() => new Promise(() => {}))
      renderPalette()
      type('a')
      expect(screen.queryByText('Searching…')).toBeNull()
      act(() => vi.advanceTimersByTime(300))
      expect(screen.getByText('Searching…')).toBeInTheDocument()
    })

    it('drops a search left behind by a newer query', async () => {
      const answers: ((r: FindResponse) => void)[] = []
      const rejects: ((e: unknown) => void)[] = []
      mockFind.mockImplementation(
        (_p, _q, signal: AbortSignal) =>
          new Promise<FindResponse>((res, rej) => {
            answers.push(res)
            rejects.push(rej)
            signal.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            )
          }),
      )
      renderPalette()
      type('a')
      await waitFor(() => expect(mockFind).toHaveBeenCalledOnce())
      type('ab')
      await waitFor(() => expect(mockFind).toHaveBeenCalledTimes(2))
      await act(async () => answers[1](found(['ab.md'])))
      expect(options()).toHaveLength(1)
    })

    it('is a disabled row where the pane has no files', () => {
      const p = renderPalette({ filesAvailable: false })
      expect(options()[0]).toHaveAttribute('aria-disabled', 'true')
      expect(options()[0]).toHaveAccessibleDescription(
        'Not available for this pane',
      )
      type('a')
      key('Enter')
      fireEvent.click(options()[0])
      expect(p.onRun).not.toHaveBeenCalled()
      expect(mockFind).not.toHaveBeenCalled()
    })
  })

  describe('commands', () => {
    it('lists every command with its category and key, filtered by letters', () => {
      renderPalette({ mode: 'commands' })
      expect(input()).toHaveValue('>')
      expect(screen.getByRole('dialog', { name: 'Commands' })).toBeVisible()
      expect(options()).toHaveLength(7)
      expect(
        screen.getByRole('option', { name: /Show all commands/ }),
      ).toHaveTextContent('Ctrl+Shift+P')
      type('>tfp')
      expect(options().map((o) => o.textContent)).toEqual([
        'View: Toggle the Files panel',
      ])
    })

    it('shows the key on Apple as symbols', () => {
      platform.apple = true
      renderPalette({ mode: 'commands' })
      expect(
        screen.getByRole('option', { name: /Show all commands/ }),
      ).toHaveTextContent('⇧⌘P')
    })

    it('shows a command that cannot run, with its reason, and runs nothing', () => {
      const p = renderPalette({ mode: 'commands' })
      type('>devices')
      const row = options()[0]
      expect(row).toHaveAttribute('aria-disabled', 'true')
      expect(row).toHaveAccessibleDescription('Not available on this server')
      key('Enter')
      expect(p.onRun).not.toHaveBeenCalled()
    })

    it('runs a command after closing, focus kept or given back', () => {
      const p = renderPalette({ mode: 'commands' })
      type('>help')
      key('Enter')
      expect(p.onRun).toHaveBeenCalledOnce()
      expect(
        p.commands.find((c) => c.id === 'app.help')?.run,
      ).toHaveBeenCalled()
      p.unmount()
      const q = renderPalette({ mode: 'commands' })
      type('>toggle files')
      key('Enter')
      expect(
        q.commands.find((c) => c.id === 'view.filesPanel')?.run,
      ).toHaveBeenCalled()
    })

    it('switches mode in place for a palette command', () => {
      const p = renderPalette({ mode: 'commands' })
      type('>go to line')
      key('Enter')
      expect(input()).toHaveValue(':')
      expect(input()).toHaveFocus()
      type('>go to tab')
      key('Enter')
      expect(input()).toHaveValue('@')
      type('>go to file')
      key('Enter')
      expect(input()).toHaveValue('')
      type('>show all')
      key('Enter')
      expect(input()).toHaveValue('>')
      expect(p.onRun).not.toHaveBeenCalled()
    })

    describe("the agent's commands", () => {
      const claude: Session = {
        ...SESSION,
        hasAgent: true,
        agentName: 'claude',
        panes: [
          { id: '%1', label: 'claude', hasAgent: true, command: 'claude' },
        ],
      }

      it('go in front of the Chat draft where the pane has a composer', () => {
        agent.list = [{ name: 'deploy', source: 'project', kind: 'command' }]
        const p = renderPalette({
          mode: 'commands',
          session: claude,
          composer: true,
        })
        expect(agent.enabled).toBe(true)
        type('>/deploy')
        expect(options()[0]).toHaveTextContent('Agent: /deploy')
        key('Enter')
        expect(p.showChat).toHaveBeenCalled()
        expect(takeDraftInsert('%1')).toMatchObject({
          name: 'deploy',
          trigger: '/',
        })
      })

      it('are typed into the terminal, without Enter, when the agent runs there', () => {
        const p = renderPalette({ mode: 'commands', session: claude })
        type('>/compact')
        key('Enter')
        expect(p.sendToTerminal).toHaveBeenCalledWith('/compact ')
      })

      it('use $ for a Codex skill', () => {
        agent.list = [{ name: 'review', source: 'user', kind: 'skill' }]
        const codex = {
          ...claude,
          agentName: 'codex',
          panes: [
            { id: '%1', label: 'codex', hasAgent: true, command: 'codex' },
          ],
        }
        const p = renderPalette({ mode: 'commands', session: codex })
        type('>$review')
        key('Enter')
        expect(p.sendToTerminal).toHaveBeenCalledWith('$review ')
      })

      it('say why they cannot run', () => {
        renderPalette({ mode: 'commands', session: claude, readOnly: true })
        type('>/compact')
        expect(options()[0]).toHaveAccessibleDescription('View only')
      })

      it('say so when the agent is not what runs in the pane', () => {
        const wrapped = {
          ...claude,
          panes: [
            { id: '%1', label: 'x', hasAgent: true, command: 'node' },
          ] as SessionPane[],
        }
        renderPalette({ mode: 'commands', session: wrapped })
        type('>/compact')
        expect(options()[0]).toHaveAccessibleDescription(
          "Open the agent's Chat to use its commands",
        )
      })

      it('are the custom ones only for an agent with no built-ins', () => {
        agent.list = [{ name: 'fix', source: 'user', kind: 'command' }]
        renderPalette({
          mode: 'commands',
          session: { ...claude, agentName: 'aider' },
        })
        type('>/')
        expect(options().map((o) => o.textContent)).toEqual([
          expect.stringContaining('Agent: /fix'),
        ])
      })

      it('are none without an agent', () => {
        renderPalette({ mode: 'commands' })
        expect(agent.enabled).toBe(false)
        type('>/compact')
        expect(options()).toHaveLength(0)
      })
    })
  })

  describe('lines', () => {
    it('asks for a file first', () => {
      renderPalette({ mode: 'line' })
      expect(options()[0]).toHaveAccessibleDescription('Open a file first')
    })

    it('has no file to go in where the pane has no files', async () => {
      const { result } = await filesStore()
      act(() => result.current.open('src/app.ts'))
      renderPalette({ mode: 'line', filesAvailable: false })
      expect(options()[0]).toHaveAccessibleDescription('Open a file first')
    })

    it('goes to a line and column of the file shown', async () => {
      const { result } = await filesStore()
      act(() => result.current.open('src/app.ts'))
      const p = renderPalette({ mode: 'line' })
      expect(options()[0]).toHaveAccessibleDescription(
        'Type a line number, or line:column',
      )
      type(':12:3')
      expect(options()[0]).toHaveTextContent('Go to line 12, column 3')
      type(':12')
      expect(options()[0]).toHaveTextContent('Go to line 12')
      key('Enter')
      expect(p.showFilesPanel).toHaveBeenCalled()
      expect(result.current.active).toMatchObject({
        path: 'src/app.ts',
        line: 12,
      })
    })
  })

  describe('tabs and panes', () => {
    it('lists the tabs of every group, names shown safely', () => {
      const p = renderPalette({ mode: 'sessions' })
      expect(options().map((o) => o.textContent)).toEqual([
        '💻 ShellCurrent tab',
        '📜 Logsmain',
        '🐚 evil⟨U+202E⟩exeother',
      ])
      type('@logs')
      key('Enter')
      expect(p.selectSession).toHaveBeenCalledWith('2')
    })

    it('lists the panes of this tab where the client picks them', () => {
      const selectPane = vi.fn()
      const split = {
        ...SESSION,
        panes: [
          { id: '%1', label: 'shell', hasAgent: false },
          { id: '%9', label: '', command: 'vim', hasAgent: false },
          { id: '%8', label: '', hasAgent: false },
        ],
      }
      renderPalette({ mode: 'sessions', session: split, selectPane })
      expect(screen.getByRole('option', { name: /shell/ })).toHaveTextContent(
        'Current pane',
      )
      expect(screen.getByRole('option', { name: /%8/ })).toBeInTheDocument()
      type('@vim')
      key('Enter')
      expect(selectPane).toHaveBeenCalledWith('%9')
    })

    it('lists a tab without a group, and no pane when the tab has none', () => {
      renderPalette({
        mode: 'sessions',
        selectPane: vi.fn(),
        sessions: [
          SESSION,
          { ...SESSION, id: 'x', name: 'loose', groupId: undefined },
        ],
      })
      type('@loose')
      expect(options().map((o) => o.textContent)).toEqual(['💻 loose'])
    })

    it('lists no pane where the backend picks it', () => {
      const split = {
        ...SESSION,
        panes: [{ id: '%9', label: 'vim', hasAgent: false }],
      }
      renderPalette({ mode: 'sessions', session: split })
      expect(screen.queryByRole('option', { name: /vim/ })).toBeNull()
    })
  })

  describe('keys', () => {
    it('move through the list, wrapping; the mouse too', () => {
      renderPalette({ mode: 'commands' })
      const selected = () =>
        options().findIndex((o) => o.getAttribute('aria-selected') === 'true')
      key('ArrowUp')
      expect(selected()).toBe(6)
      key('ArrowDown')
      expect(selected()).toBe(0)
      key('PageDown')
      expect(selected()).toBe(6)
      key('PageUp')
      expect(selected()).toBe(0)
      fireEvent.mouseMove(options()[2])
      expect(selected()).toBe(2)
      fireEvent.mouseMove(options()[2])
      // Other keys are the input's
      key('a')
      expect(selected()).toBe(2)
      expect(fireEvent.mouseDown(options()[1])).toBe(false)
    })

    it('do nothing on an empty list', () => {
      renderPalette({ mode: 'commands' })
      type('>zzzz')
      key('ArrowDown')
      key('Enter')
      expect(options()).toHaveLength(0)
    })

    it('of the palette change its mode and never reach the browser', () => {
      renderPalette()
      const commandsKey = new KeyboardEvent('keydown', {
        key: 'P',
        code: 'KeyP',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
      act(() => {
        input().dispatchEvent(commandsKey)
      })
      expect(commandsKey.defaultPrevented).toBe(true)
      expect(input()).toHaveValue('>')
      // Its own key again moves down the list
      fireEvent.keyDown(input(), {
        key: 'P',
        code: 'KeyP',
        ctrlKey: true,
        shiftKey: true,
      })
      expect(options()[1]).toHaveAttribute('aria-selected', 'true')
      fireEvent.keyDown(input(), { key: 'p', code: 'KeyP', ctrlKey: true })
      expect(input()).toHaveValue('')
    })

    it('follow keys the user changed', () => {
      setShortcut('palette.sessions', { key: 'Mod+Alt+S' })
      renderPalette()
      fireEvent.keyDown(input(), {
        key: 's',
        code: 'KeyS',
        ctrlKey: true,
        altKey: true,
      })
      expect(input()).toHaveValue('@')
    })

    it('pin a file with Cmd+Enter on Apple, and a click with Cmd', async () => {
      platform.apple = true
      const { result } = await filesStore()
      act(() => result.current.open('a.md'))
      act(() => result.current.open('b.md'))
      renderPalette()
      key('Enter', { metaKey: true })
      expect(result.current.active).toMatchObject({
        path: 'a.md',
        pinned: true,
      })
      renderPalette()
      fireEvent.click(options()[0], { metaKey: true })
      expect(result.current.active).toMatchObject({
        path: 'b.md',
        pinned: true,
      })
    })
  })

  describe('closes', () => {
    it('when another pane is shown', () => {
      const p = renderPalette()
      p.rerender(
        <CommandPalette {...p} session={{ ...SESSION, paneId: '%2' }} />,
      )
      expect(p.onClose).toHaveBeenCalled()
    })

    it('when the pane id moves, not for another pane', () => {
      const p = renderPalette()
      act(() =>
        remapPanes({ moved: new Map([['%7', '%8']]), stale: new Set(['%7']) }),
      )
      expect(p.onClose).not.toHaveBeenCalled()
      act(() =>
        remapPanes({ moved: new Map([['%1', '%2']]), stale: new Set(['%1']) }),
      )
      expect(p.onClose).toHaveBeenCalledOnce()
    })
  })

  it('works for a tab without a pane yet', () => {
    renderPalette({ session: { ...SESSION, paneId: undefined } })
    expect(options()[0]).toHaveAccessibleDescription(
      'Not available for this pane',
    )
  })
})

describe('CommandPalette prompt templates', () => {
  const claude: Session = {
    ...SESSION,
    hasAgent: true,
    agentName: 'claude',
    panes: [{ id: '%1', label: 'claude', hasAgent: true, command: 'claude' }],
  }
  let fills: TemplateFill[] = []
  let off = () => {}
  beforeEach(() => {
    prompts.refresh.mockClear()
    prompts.templates = [
      {
        id: 't1',
        name: 'Zebra\u202e review',
        text: 'Look at {{file}}\nnow',
        updated: 'u',
      },
    ]
    fills = []
    off = onTemplateFill(() => {
      const f = takeTemplateFill()
      if (f) fills.push(f)
    })
  })
  afterEach(() => off())

  it('are listed with the commands, read again, and filled for the Chat', () => {
    const p = renderPalette({
      mode: 'commands',
      session: claude,
      composer: true,
      templates: true,
    })
    expect(prompts.refresh).toHaveBeenCalled()
    type('>zebra')
    expect(options()[0]).toHaveTextContent('Template: Zebra⟨U+202E⟩ review')
    expect(options()[0]).toHaveTextContent('Look at {{file}}')
    key('Enter')
    expect(p.showChat).toHaveBeenCalled()
    expect(fills).toEqual([{ paneId: '%1', templateId: 't1', agent: 'claude' }])
  })

  it('say why they cannot be used', () => {
    const { unmount } = renderPalette({
      mode: 'commands',
      session: claude,
      templates: true,
      readOnly: true,
    })
    type('>zebra')
    expect(options()[0]).toHaveAccessibleDescription('View only')
    unmount()
    renderPalette({ mode: 'commands', session: claude, templates: true })
    type('>zebra')
    expect(options()[0]).toHaveAccessibleDescription(
      "Open the agent's Chat to use templates",
    )
    key('Enter')
    expect(fills).toEqual([])
  })

  it('are not there without them on the server, nor outside commands', () => {
    renderPalette({ mode: 'commands', session: claude, composer: true })
    type('>zebra')
    expect(options()).toHaveLength(0)
    expect(prompts.refresh).not.toHaveBeenCalled()
  })
})
