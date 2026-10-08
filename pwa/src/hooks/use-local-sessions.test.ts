import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted — use vi.hoisted to declare mocks before the factory runs
const {
  mockFetchTabs,
  mockCreateTab,
  mockCloseTab,
  mockClosePane,
  mockRenameTab,
  mockSelectTab,
  mockCreateGroup,
  mockRenameGroup,
  mockCloseGroup,
  mockCreateWorktree,
  mockOpenWorktree,
  mockRemoveWorktree,
  mockSnapshot,
  mockFetchHealth,
  mockReportLargePacketLoss,
} = vi.hoisted(() => ({
  mockFetchHealth: vi.fn(),
  mockReportLargePacketLoss: vi.fn(),
  // Overrides merged into every snapshot (backend, caps, groups).
  mockSnapshot: { extra: {} as Record<string, unknown> },
  mockFetchTabs: vi.fn(),
  mockCreateTab: vi.fn(),
  mockCloseTab: vi.fn(),
  mockClosePane: vi.fn(),
  mockRenameTab: vi.fn(),
  mockSelectTab: vi.fn(),
  mockCreateGroup: vi.fn(),
  mockRenameGroup: vi.fn(),
  mockCloseGroup: vi.fn(),
  mockCreateWorktree: vi.fn(),
  mockOpenWorktree: vi.fn(),
  mockRemoveWorktree: vi.fn(),
}))

vi.mock('./use-mux-api', async (importOriginal) => ({
  RequestError: (await importOriginal<typeof import('./use-mux-api')>())
    .RequestError,
  createWorktree: mockCreateWorktree,
  openWorktree: mockOpenWorktree,
  removeWorktree: mockRemoveWorktree,
  fetchSnapshot: async () => ({
    apiVersion: 1,
    backend: 'tmux',
    caps: { clientSideSelect: false, copyMode: true },
    groups: [{ id: 'main', name: 'main', tabs: await mockFetchTabs() }],
    ...mockSnapshot.extra,
  }),
  createTab: mockCreateTab,
  closeTab: mockCloseTab,
  closePane: mockClosePane,
  renameTab: mockRenameTab,
  selectTab: mockSelectTab,
  createGroup: mockCreateGroup,
  renameGroup: mockRenameGroup,
  closeGroup: mockCloseGroup,
  fetchHealth: mockFetchHealth,
}))

vi.mock('../utils/large-packet-loss', async (orig) => ({
  ...(await orig<typeof import('../utils/large-packet-loss')>()),
  reportLargePacketLoss: mockReportLargePacketLoss,
}))

import { useLocalSessions } from './use-local-sessions'

const WIN_SHELL = { id: '0', name: 'shell', active: true, panes: [] }
const WIN_VIM = { id: '1', name: 'vim', active: false, panes: [] }

describe('useLocalSessions', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockSnapshot.extra = {}
    mockFetchTabs.mockResolvedValue([WIN_SHELL])
    mockCreateTab.mockResolvedValue(true)
    mockCloseTab.mockResolvedValue(true)
    mockRenameTab.mockResolvedValue(true)
    mockSelectTab.mockResolvedValue(true)
  })

  it('loads sessions from tmux API on mount', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.sessions).toHaveLength(1)
    expect(result.current.sessions[0].name).toBe('shell')
  })

  it('sets isReady=true after first fetch', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.isReady).toBe(true)
  })

  it('sets isServerReachable=true on success', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.isServerReachable).toBe(true)
  })

  it("maps each pane's process and the tab's processes", async () => {
    mockFetchTabs.mockResolvedValue([
      {
        ...WIN_SHELL,
        panes: [
          { id: '0', active: true, process: { name: 'vim', cwd: '/src' } },
        ],
        // tmux lists every pane of the window here, the split ones too
        processes: [{ name: 'bash' }, { name: 'vim' }, { name: 'bash' }],
      },
      {
        ...WIN_VIM,
        panes: [{ id: '1', active: true, process: { name: 'top' } }],
      },
      { id: '2', name: 'idle', active: false, panes: [{ id: '2' }] },
    ])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    const [shell, vim, idle] = result.current.sessions
    expect(shell.panes?.[0].command).toBe('vim')
    expect(shell.commands).toEqual(['bash', 'vim'])
    expect(vim.commands).toEqual(['top'])
    expect(idle.panes?.[0].command).toBeUndefined()
    expect(idle.commands).toBeUndefined()
  })

  it('sets activeSession to the active window', async () => {
    mockFetchTabs.mockResolvedValue([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.activeSession.name).toBe('shell')
  })

  it('falls back to first session when none is active', async () => {
    mockFetchTabs.mockResolvedValue([
      { id: '0', name: 'vim', active: false, panes: [] },
      { id: '1', name: 'bash', active: false, panes: [] },
    ])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.activeSession.name).toBe('vim')
  })

  it('creates default window when fetchWindows returns empty', async () => {
    mockFetchTabs.mockResolvedValueOnce([]).mockResolvedValueOnce([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(mockCreateTab).toHaveBeenCalledWith('shell')
    expect(result.current.sessions[0].name).toBe('shell')
  })

  it('uses fallback session when API throws on first load', async () => {
    mockFetchTabs.mockRejectedValue(new Error('API down'))
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.isServerReachable).toBe(false)
    expect(result.current.isReady).toBe(true)
    expect(result.current.sessions[0].name).toBe('shell')
    expect(result.current.activeSession.name).toBe('shell')
  })

  it('asks for health when the snapshot times out, and reports lost replies if it answers', async () => {
    mockFetchTabs.mockRejectedValue(
      new DOMException('signal timed out', 'TimeoutError'),
    )
    mockFetchHealth.mockResolvedValue({ apiVersion: 1 })
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.isServerReachable).toBe(false)
    expect(mockFetchHealth).toHaveBeenCalledTimes(1)
    expect(mockReportLargePacketLoss).toHaveBeenCalledTimes(1)
  })

  it('reports nothing when health times out too', async () => {
    mockFetchTabs.mockRejectedValue(
      new DOMException('signal timed out', 'TimeoutError'),
    )
    mockFetchHealth.mockRejectedValue(
      new DOMException('signal timed out', 'TimeoutError'),
    )
    renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(mockFetchHealth).toHaveBeenCalledTimes(1)
    expect(mockReportLargePacketLoss).not.toHaveBeenCalled()
  })

  it('does not ask for health when the snapshot fails outright', async () => {
    mockFetchTabs.mockRejectedValue(new Error('API down'))
    renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(mockFetchHealth).not.toHaveBeenCalled()
  })

  it('skips a poll while the previous read is still waiting', async () => {
    vi.useFakeTimers()
    try {
      let release: (tabs: unknown[]) => void = () => {}
      mockFetchTabs.mockReturnValueOnce(
        new Promise((resolve) => {
          release = resolve
        }),
      )
      renderHook(() => useLocalSessions(1))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000)
      })
      expect(mockFetchTabs).toHaveBeenCalledTimes(1)
      await act(async () => {
        release([WIN_SHELL])
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(mockFetchTabs).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reset sessions on subsequent API errors after ready', async () => {
    mockFetchTabs
      .mockResolvedValueOnce([WIN_SHELL])
      .mockRejectedValue(new Error('API down'))
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.sessions).toHaveLength(1)
    expect(result.current.isServerReachable).toBe(false)
  })

  it('returns Loading placeholder when activeSession is null initially', () => {
    mockFetchTabs.mockReturnValue(new Promise(() => {})) // never resolves
    const { result } = renderHook(() => useLocalSessions(1))
    expect(result.current.activeSession.name).toBe('Loading...')
  })

  it('switchSession selects a different session', async () => {
    mockFetchTabs.mockResolvedValue([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.switchSession('1')
    })
    expect(mockSelectTab).toHaveBeenCalledWith('1')
    expect(result.current.activeSession.name).toBe('vim')
  })

  it('switchSession on tmux only selects: the one write a deep link may cause', async () => {
    mockFetchTabs.mockResolvedValue([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.switchSession('1', 'ignored-pane')
    })
    expect(mockSelectTab).toHaveBeenCalledOnce()
    expect(mockSelectTab).toHaveBeenCalledWith('1')
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockCloseTab).not.toHaveBeenCalled()
    expect(mockRenameTab).not.toHaveBeenCalled()
  })

  it('switchSession does nothing when session not found', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.switchSession('999')
    })
    expect(mockSelectTab).not.toHaveBeenCalled()
  })

  it('switchSession does nothing when already active', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.switchSession('0')
    })
    expect(mockSelectTab).not.toHaveBeenCalled()
  })

  it('addSession creates window and refreshes', async () => {
    mockFetchTabs
      .mockResolvedValueOnce([WIN_SHELL])
      .mockResolvedValueOnce([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.addSession('vim', '🖥️', 'Editor')
    })
    expect(mockCreateTab).toHaveBeenCalledWith('vim', 'main')
    expect(result.current.sessions).toHaveLength(2)
  })

  it('addSession stores metadata in localStorage', async () => {
    mockFetchTabs
      .mockResolvedValueOnce([WIN_SHELL])
      .mockResolvedValueOnce([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.addSession('vim', '🖥️', 'My editor')
    })
    const meta = JSON.parse(localStorage.getItem('termote-sessions')!)
    expect(meta['tmux:name:vim']).toEqual({
      icon: '🖥️',
      description: 'My editor',
    })
  })

  it('addSession uses default icon when not specified', async () => {
    mockFetchTabs
      .mockResolvedValueOnce([WIN_SHELL])
      .mockResolvedValueOnce([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.addSession('vim')
    })
    const meta = JSON.parse(localStorage.getItem('termote-sessions')!)
    expect(meta['tmux:name:vim'].icon).toBe('📺')
  })

  it('removeSession kills window and refreshes', async () => {
    mockFetchTabs
      .mockResolvedValueOnce([WIN_SHELL, WIN_VIM])
      .mockResolvedValueOnce([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.removeSession('1')
    })
    expect(mockCloseTab).toHaveBeenCalledWith('1')
    expect(result.current.sessions).toHaveLength(1)
  })

  it('removePane does nothing before the first snapshot', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {
      await result.current.removePane('0')
    })
    expect(mockClosePane).not.toHaveBeenCalled()
  })

  it('removeSession does nothing when only one session', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.removeSession('0')
    })
    expect(mockCloseTab).not.toHaveBeenCalled()
  })

  it('removeSession does nothing when session not found', async () => {
    mockFetchTabs.mockResolvedValue([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.removeSession('999')
    })
    expect(mockCloseTab).not.toHaveBeenCalled()
  })

  it('updateSession updates name and renames tmux window', async () => {
    mockFetchTabs.mockResolvedValue([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.updateSession('0', { name: 'renamed' })
    })
    expect(mockRenameTab).toHaveBeenCalledWith('0', 'renamed')
    expect(result.current.sessions[0].name).toBe('renamed')
  })

  it('updateSession keeps name and metadata when rename is rejected', async () => {
    mockFetchTabs.mockResolvedValue([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.updateSession('0', { icon: '⭐' })
    })
    mockRenameTab.mockResolvedValueOnce(false)
    await act(async () => {
      await result.current.updateSession('0', { name: '-bad' })
    })
    mockRenameTab.mockRejectedValueOnce(new Error('network'))
    await act(async () => {
      await result.current.updateSession('0', { name: 'offline' })
    })
    expect(result.current.sessions[0].name).toBe('shell')
    expect(result.current.sessions[0].icon).toBe('⭐')
  })

  it('updateSession updates icon and description without renaming', async () => {
    mockFetchTabs.mockResolvedValue([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.updateSession('0', {
        icon: '🔥',
        description: 'Hot session',
      })
    })
    expect(mockRenameTab).not.toHaveBeenCalled()
    expect(result.current.sessions[0].icon).toBe('🔥')
    expect(result.current.sessions[0].description).toBe('Hot session')
  })

  it('updateSession does nothing when session not found', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.updateSession('999', { name: 'ghost' })
    })
    expect(mockRenameTab).not.toHaveBeenCalled()
  })

  it('updateSession also updates activeSession when it matches', async () => {
    mockFetchTabs.mockResolvedValue([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.updateSession('0', { icon: '⭐' })
    })
    expect(result.current.activeSession.icon).toBe('⭐')
  })

  it('loads metadata from localStorage for sessions', async () => {
    localStorage.setItem(
      'termote-sessions',
      JSON.stringify({
        shell: { icon: '🐚', description: 'My shell' },
      }),
    )
    mockFetchTabs.mockResolvedValue([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.sessions[0].icon).toBe('🐚')
    expect(result.current.sessions[0].description).toBe('My shell')
  })

  it('moves 0.x metadata keyed by window name under the tmux prefix', async () => {
    localStorage.setItem(
      'termote-sessions',
      JSON.stringify({
        shell: { icon: '🐚', description: '' },
        'tmux:name:vim': { icon: '📝', description: '' },
        'herdr:w1:t1': { icon: '🤖', description: '' },
      }),
    )
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(JSON.parse(localStorage.getItem('termote-sessions')!)).toEqual({
      'tmux:name:shell': { icon: '🐚', description: '' },
      'tmux:name:vim': { icon: '📝', description: '' },
      'herdr:w1:t1': { icon: '🤖', description: '' },
    })
    expect(result.current.sessions[0].icon).toBe('🐚')
  })

  it('leaves already migrated metadata untouched', async () => {
    const stored = JSON.stringify({
      'tmux:name:shell': { icon: '🐚', description: '' },
    })
    localStorage.setItem('termote-sessions', stored)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(setItem).not.toHaveBeenCalledWith('termote-sessions', stored)
    setItem.mockRestore()
  })

  it('uses default icon when no metadata exists for a window', async () => {
    mockFetchTabs.mockResolvedValue([WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.sessions[0].icon).toBe('📺')
  })

  it('handles corrupt localStorage metadata gracefully', async () => {
    localStorage.setItem('termote-sessions', 'not-json')
    mockFetchTabs.mockResolvedValue([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.sessions[0].name).toBe('shell')
  })

  it('activeSession falls back to null (Loading placeholder) when applyWindows receives empty array', async () => {
    // applyWindows with empty array: mapped=[], active=undefined, mapped[0]=undefined → ?? null → null
    // This hits the `?? null` branch in: active ? ... : (mapped[0] ?? null)
    mockFetchTabs.mockResolvedValueOnce([]).mockResolvedValueOnce([]) // both fetches return empty
    mockCreateTab.mockResolvedValue(true)
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    // activeSession is null internally → returns the Loading placeholder from the return statement
    expect(result.current.activeSession.name).toBe('Loading...')
  })

  it('updateSession updates only the matching session in sessions array (non-active session)', async () => {
    mockFetchTabs.mockResolvedValue([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    // active session is WIN_SHELL (id='0'), update WIN_VIM (id='1') which is NOT active
    await act(async () => {
      await result.current.updateSession('1', { icon: '🎯' })
    })
    const updatedVim = result.current.sessions.find((s) => s.id === '1')
    expect(updatedVim?.icon).toBe('🎯')
    // Active session (shell) should not be updated
    expect(result.current.activeSession.name).toBe('shell')
  })

  it('exposes backend and caps, keeping the object while they are unchanged', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    const first = result.current.mux
    expect(first).toEqual({
      backend: 'tmux',
      caps: { clientSideSelect: false, copyMode: true },
    })
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.mux).toBe(first)

    mockSnapshot.extra = {
      backend: 'herdr',
      caps: { clientSideSelect: true, copyMode: false },
    }
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.mux).toEqual({
      backend: 'herdr',
      caps: { clientSideSelect: true, copyMode: false },
    })
  })

  it('a cap the default does not have reaches the state (agentChat on tmux)', async () => {
    mockSnapshot.extra = {
      caps: { clientSideSelect: false, copyMode: true, agentChat: true },
    }
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.mux.caps.agentChat).toBe(true)
  })

  it('the active pane carries the agent name', async () => {
    mockSnapshot.extra = {
      groups: [
        {
          id: 'main',
          name: 'main',
          tabs: [
            {
              id: '0',
              name: 'claude',
              active: true,
              panes: [
                {
                  id: '0',
                  active: true,
                  agent: { name: 'claude', status: 'idle' },
                },
              ],
            },
          ],
        },
      ],
    }
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.activeSession).toMatchObject({
      hasAgent: true,
      agentName: 'claude',
      agentStatus: 'idle',
    })
  })

  it('treats a snapshot without groups as empty', async () => {
    mockSnapshot.extra = { groups: undefined }
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    // No tabs: the hook asks for a first one
    expect(mockCreateTab).toHaveBeenCalledWith('shell')
    expect(result.current.sessions).toEqual([])
  })

  it('streams the active pane of each tab and flags agents', async () => {
    mockSnapshot.extra = {
      backend: 'herdr',
      groups: [
        {
          id: 'w1',
          name: 'w1',
          tabs: [
            {
              id: 'w1:t1',
              name: 'agent',
              active: true,
              panes: [
                { id: 'w1:p1', active: false },
                {
                  id: 'w1:p2',
                  active: true,
                  agent: { name: 'claude', status: 'working' },
                },
              ],
            },
          ],
        },
        {
          id: 'w2',
          name: 'w2',
          tabs: [
            {
              id: 'w2:t1',
              name: 'shell',
              active: false,
              panes: [{ id: 'w2:p1', active: false }],
            },
          ],
        },
      ],
    }
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(
      result.current.sessions.map((s) => [s.id, s.paneId, s.hasAgent]),
    ).toEqual([
      ['w1:t1', 'w1:p2', true],
      ['w2:t1', 'w2:p1', false],
    ])
  })

  it('exposes one group for tmux, tagging every tab with it', async () => {
    mockFetchTabs.mockResolvedValue([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.groups).toEqual([
      { id: 'main', name: 'main', agentStatus: undefined },
    ])
    expect(result.current.sessions.map((s) => s.groupId)).toEqual([
      'main',
      'main',
    ])
  })

  it('tmux ignores selectPane: only the session is kept', async () => {
    mockFetchTabs.mockResolvedValue([
      { ...WIN_SHELL, panes: [{ id: '0', active: true }] },
    ])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    act(() => result.current.selectPane('0'))
    expect(JSON.parse(localStorage.getItem('termote-selection-tmux')!)).toEqual(
      { tabId: '0', groupId: 'main' },
    )
  })

  it('tmux follows the window the server reports as current', async () => {
    mockFetchTabs
      .mockResolvedValueOnce([WIN_SHELL, WIN_VIM])
      .mockResolvedValue([
        { ...WIN_SHELL, active: false },
        { ...WIN_VIM, active: true },
      ])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.activeSession.id).toBe('0')
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.activeSession.id).toBe('1')
  })
})

describe('useLocalSessions with several tmux sessions', () => {
  const tab = (id: string, name: string, active: boolean) => ({
    id,
    name,
    active,
    panes: [{ id, active: true }],
  })
  // The default session (id = its name, bare tab ids) and "$3".
  const groups = (mainActive = '0', workActive = '$3:1', withWork = true) => [
    {
      id: 'main',
      name: 'main',
      tabs: [
        tab('0', 'shell', mainActive === '0'),
        tab('1', 'logs', mainActive === '1'),
      ],
    },
    ...(withWork
      ? [
          {
            id: '$3',
            name: 'work',
            tabs: [
              tab('$3:0', 'shell', workActive === '$3:0'),
              tab('$3:1', 'build', workActive === '$3:1'),
            ],
          },
        ]
      : []),
  ]
  const saved = () =>
    JSON.parse(localStorage.getItem('termote-selection-tmux') ?? 'null')

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockFetchTabs.mockResolvedValue([])
    mockSnapshot.extra = { groups: groups() }
    mockSelectTab.mockResolvedValue(true)
    mockCreateTab.mockResolvedValue('$3:2')
    mockRenameTab.mockResolvedValue(true)
    mockCloseTab.mockResolvedValue(true)
  })

  it('without a saved session, shows the default session and keeps it', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.activeSession.id).toBe('0')
    expect(result.current.groups.map((g) => g.id)).toEqual(['main', '$3'])
    expect(saved()).toEqual({ tabId: '0', groupId: 'main' })
  })

  it('shows the current window of the saved session', async () => {
    localStorage.setItem(
      'termote-selection-tmux',
      JSON.stringify({ tabId: '$3:0', groupId: '$3' }),
    )
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    // The session's current window, not the one saved with it.
    expect(result.current.activeSession.id).toBe('$3:1')
    expect(saved()).toEqual({ tabId: '$3:0', groupId: '$3' })
  })

  it('follows the current window of its session only', async () => {
    localStorage.setItem('termote-selection-tmux', '{"groupId":"$3"}')
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    // Another device moves the default session: this one stays on $3.
    mockSnapshot.extra = { groups: groups('1', '$3:0') }
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.activeSession.id).toBe('$3:0')
  })

  it('a session that is gone gives way to the default one', async () => {
    localStorage.setItem('termote-selection-tmux', '{"groupId":"$3"}')
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    mockSnapshot.extra = { groups: groups('1', '', false) }
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.activeSession.id).toBe('1')
    expect(saved()).toEqual({ tabId: '1', groupId: 'main' })
  })

  it('a session with no current window shows its first one', async () => {
    localStorage.setItem('termote-selection-tmux', '{"groupId":"$3"}')
    mockSnapshot.extra = { groups: groups('0', 'none') }
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.activeSession.id).toBe('$3:0')
  })

  it('falls back to the server pick when no group has a tab', async () => {
    mockSnapshot.extra = { groups: [{ id: 'main', name: 'main', tabs: [] }] }
    mockFetchTabs.mockResolvedValue([])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.activeSession.name).toBe('Loading...')
  })

  it('switching to another session shows the tab at once and keeps it', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    let release!: (v: unknown[]) => void
    mockFetchTabs.mockReturnValueOnce(
      new Promise((r) => {
        release = r
      }),
    )
    // A poll sent before the pick, answered after it.
    let poll!: Promise<void>
    act(() => {
      poll = result.current.refreshSessions()
    })
    await act(async () => {
      await result.current.switchSession('$3:0')
    })
    expect(mockSelectTab).toHaveBeenCalledWith('$3:0')
    expect(result.current.activeSession.id).toBe('$3:0')
    expect(saved()).toEqual({ tabId: '$3:0', groupId: '$3' })
    await act(async () => {
      release([])
      await poll
    })
    expect(result.current.activeSession.id).toBe('$3:0')
  })

  it('keeps metadata per session, the default one under its old key', async () => {
    localStorage.setItem(
      'termote-sessions',
      JSON.stringify({
        'tmux:name:shell': { icon: '🏠', description: 'home' },
        'tmux:name:$3\u0000shell': { icon: '🛠', description: 'work' },
      }),
    )
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    const icon = (id: string) =>
      result.current.sessions.find((s) => s.id === id)?.icon
    expect(icon('0')).toBe('🏠')
    expect(icon('$3:0')).toBe('🛠')
    expect(icon('$3:1')).toBe('📺')
  })

  it('a new tab of another session keeps its metadata there', async () => {
    localStorage.setItem('termote-selection-tmux', '{"groupId":"$3"}')
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.addSession('shell', '🧪', 'tests')
    })
    expect(mockCreateTab).toHaveBeenCalledWith('shell', '$3')
    const meta = JSON.parse(localStorage.getItem('termote-sessions')!)
    expect(meta['tmux:name:$3\u0000shell']).toEqual({
      icon: '🧪',
      description: 'tests',
    })
    expect(meta['tmux:name:shell']).toBeUndefined()
  })

  it('renaming and closing a tab of another session use its key', async () => {
    localStorage.setItem(
      'termote-sessions',
      JSON.stringify({
        'tmux:name:$3\u0000build': { icon: '🔨', description: '' },
      }),
    )
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.updateSession('$3:1', { name: 'make' })
    })
    let meta = JSON.parse(localStorage.getItem('termote-sessions')!)
    expect(meta['tmux:name:$3\u0000make']).toEqual({
      icon: '🔨',
      description: '',
    })
    expect(meta['tmux:name:$3\u0000build']).toBeUndefined()
    await act(async () => {
      await result.current.removeSession('$3:1')
    })
    meta = JSON.parse(localStorage.getItem('termote-sessions')!)
    expect(meta['tmux:name:$3\u0000make']).toBeUndefined()
  })
})

describe('useLocalSessions group actions on tmux', () => {
  const tab = (id: string, name: string, active: boolean) => ({
    id,
    name,
    active,
    panes: [{ id, active: true }],
  })
  const main = { id: 'main', name: 'main', tabs: [tab('0', 'shell', true)] }
  const work = { id: '$3', name: 'work', tabs: [tab('$3:0', 'build', true)] }

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockFetchTabs.mockResolvedValue([])
    mockSnapshot.extra = { groups: [main] }
    mockSelectTab.mockResolvedValue(true)
  })

  it('a new session shows its first tab', async () => {
    mockCreateGroup.mockImplementation(async () => {
      mockSnapshot.extra = { groups: [main, work] }
      return '$3'
    })
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.createGroup('work', '/srv')
    })
    expect(mockCreateGroup).toHaveBeenCalledWith('work', '/srv')
    expect(result.current.activeSession.id).toBe('$3:0')
  })

  it('a create the dialog gave up on shows nothing new', async () => {
    mockCreateGroup.mockImplementation(async () => {
      mockSnapshot.extra = { groups: [main, work] }
      return '$3'
    })
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.createGroup('work', '', () => false)
    })
    expect(result.current.groups.map((g) => g.id)).toEqual(['main', '$3'])
    expect(result.current.activeSession.id).toBe('0')
  })

  it('a refused create reaches the caller and changes nothing', async () => {
    mockCreateGroup.mockRejectedValue(new Error('exists'))
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await expect(result.current.createGroup('main')).rejects.toThrow('exists')
    expect(result.current.activeSession.id).toBe('0')
  })

  it('renames a session and reads the list again', async () => {
    mockSnapshot.extra = { groups: [main, work] }
    mockRenameGroup.mockImplementation(async () => {
      mockSnapshot.extra = { groups: [main, { ...work, name: 'web' }] }
    })
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.renameGroup('$3', 'web')
    })
    expect(mockRenameGroup).toHaveBeenCalledWith('$3', 'web')
    expect(result.current.groups[1].name).toBe('web')
  })

  it('closing the session on screen shows the default one and drops its metadata', async () => {
    localStorage.setItem(
      'termote-sessions',
      JSON.stringify({
        'tmux:name:$3\u0000build': { icon: '🔨', description: '' },
        'tmux:name:shell': { icon: '🏠', description: '' },
      }),
    )
    localStorage.setItem('termote-selection-tmux', '{"groupId":"$3"}')
    mockSnapshot.extra = { groups: [main, work] }
    mockCloseGroup.mockImplementation(async () => {
      mockSnapshot.extra = { groups: [main] }
    })
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.activeSession.id).toBe('$3:0')
    await act(async () => {
      await result.current.closeGroup('$3')
    })
    expect(result.current.activeSession.id).toBe('0')
    const meta = JSON.parse(localStorage.getItem('termote-sessions')!)
    expect(meta['tmux:name:$3\u0000build']).toBeUndefined()
    expect(meta['tmux:name:shell']).toBeDefined()
  })
})

describe('useLocalSessions — worktrees', () => {
  const tab = (id: string) => ({
    id,
    name: 'shell',
    active: true,
    panes: [{ id, active: true }],
  })
  const repo = {
    id: 'w1',
    name: 'repo',
    tabs: [tab('w1:t1')],
    worktree: { linked: false, branch: 'main' },
  }
  const wt = {
    id: 'w2',
    name: 'feat',
    tabs: [tab('w2:t1')],
    worktree: { linked: true, branch: 'feat/x' },
  }

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockFetchTabs.mockResolvedValue([])
    mockSnapshot.extra = { backend: 'herdr', groups: [repo] }
    mockSelectTab.mockResolvedValue(true)
  })

  it("carries each group's worktree and branch", async () => {
    mockSnapshot.extra = {
      backend: 'herdr',
      groups: [repo, wt, { ...wt, id: 'w3', worktree: undefined }],
    }
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.groups.map((g) => g.worktree)).toEqual([
      { linked: false, branch: 'main' },
      { linked: true, branch: 'feat/x' },
      undefined,
    ])
  })

  it('a new worktree shows its workspace', async () => {
    mockCreateWorktree.mockImplementation(async () => {
      mockSnapshot.extra = { backend: 'herdr', groups: [repo, wt] }
      return 'w2'
    })
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    const w = { groupId: 'w1', branch: 'feat/x', base: '', label: '' }
    await act(async () => {
      await result.current.createWorktree(w)
    })
    expect(mockCreateWorktree).toHaveBeenCalledWith(w)
    expect(result.current.activeSession.id).toBe('w2:t1')
  })

  it('an open the dialog gave up on shows nothing new', async () => {
    mockOpenWorktree.mockImplementation(async () => {
      mockSnapshot.extra = { backend: 'herdr', groups: [repo, wt] }
      return 'w2'
    })
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.openWorktree('w1', 'feat/x', () => false)
    })
    expect(mockOpenWorktree).toHaveBeenCalledWith('w1', 'feat/x')
    expect(result.current.groups.map((g) => g.id)).toEqual(['w1', 'w2'])
    expect(result.current.activeSession.id).toBe('w1:t1')
  })

  it('opens with the dialog open by default, and shows an open group', async () => {
    mockOpenWorktree.mockImplementation(async () => {
      mockSnapshot.extra = { backend: 'herdr', groups: [repo, wt] }
      return 'w2'
    })
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.openWorktree('w1', 'feat/x')
    })
    expect(result.current.activeSession.id).toBe('w2:t1')
    await act(async () => {
      await result.current.showGroup('w1')
    })
    expect(result.current.activeSession.id).toBe('w1:t1')
  })

  it('removes a worktree workspace and reads the list again', async () => {
    mockSnapshot.extra = { backend: 'herdr', groups: [repo, wt] }
    mockRemoveWorktree.mockImplementation(async () => {
      mockSnapshot.extra = { backend: 'herdr', groups: [repo] }
    })
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.removeWorktree('w2', {
        force: true,
        path: '/wt/feat-x',
        branch: 'feat/x',
      })
    })
    expect(result.current.groups.map((g) => g.id)).toEqual(['w1'])
  })

  it('a refusal other than unknown reaches the caller without a read', async () => {
    const { RequestError } = await import('./use-mux-api')
    mockCreateWorktree.mockRejectedValue(new RequestError(409, 'dirty', 'x'))
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    mockFetchTabs.mockClear()
    await expect(
      result.current.createWorktree({
        groupId: 'w1',
        branch: 'a',
        base: '',
        label: '',
      }),
    ).rejects.toMatchObject({ code: 'dirty' })
    mockCreateWorktree.mockRejectedValue(new Error('lost'))
    await expect(
      result.current.createWorktree({
        groupId: 'w1',
        branch: 'a',
        base: '',
        label: '',
      }),
    ).rejects.toThrow('lost')
    expect(mockFetchTabs).not.toHaveBeenCalled()
  })

  it('reads the list again after an unknown, and still reports it', async () => {
    const { RequestError } = await import('./use-mux-api')
    mockRemoveWorktree.mockImplementation(async () => {
      mockSnapshot.extra = { backend: 'herdr', groups: [repo] }
      throw new RequestError(504, 'unknown', 'late')
    })
    mockSnapshot.extra = { backend: 'herdr', groups: [repo, wt] }
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    const w = { force: false, path: '/wt/feat-x', branch: 'feat/x' }
    await act(async () => {
      await expect(result.current.removeWorktree('w2', w)).rejects.toThrow(
        'late',
      )
    })
    expect(mockRemoveWorktree).toHaveBeenCalledWith('w2', w)
    expect(result.current.groups.map((g) => g.id)).toEqual(['w1'])
  })
})

describe('useLocalSessions with herdr', () => {
  const pane = (
    id: string,
    active: boolean,
    agent?: { name: string; status: string },
    title?: string,
  ) => ({ id, active, agent, title })

  // Two workspaces; the desktop is on w1:t1 and w2:t1.
  const herdr = (w1Active = 'w1:t1') => ({
    backend: 'herdr',
    caps: { clientSideSelect: true, copyMode: false },
    groups: [
      {
        id: 'w1',
        name: 'api',
        tabs: [
          {
            id: 'w1:t1',
            name: 'agents',
            active: w1Active === 'w1:t1',
            panes: [
              pane('w1:p1', true, { name: 'claude', status: 'working' }),
              pane('w1:p2', false, { name: 'codex', status: 'blocked' }),
              pane('w1:p3', false, undefined, 'logs'),
              pane('w1:p4', false),
            ],
          },
          {
            id: 'w1:t2',
            name: 'shell',
            active: w1Active === 'w1:t2',
            panes: [pane('w1:p5', true, { name: 'pi', status: 'weird' })],
          },
        ],
      },
      {
        id: 'w2',
        name: 'web',
        tabs: [
          {
            id: 'w2:t1',
            name: 'dev',
            active: true,
            panes: [pane('w2:p1', true, { name: 'claude', status: 'done' })],
          },
        ],
      },
    ],
  })

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockSnapshot.extra = herdr()
    mockCreateTab.mockResolvedValue('w2:t9')
    mockCloseTab.mockResolvedValue(true)
    mockRenameTab.mockResolvedValue(true)
  })

  const render = async () => {
    const hook = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    return hook
  }

  it('builds groups with the heaviest agent status of their panes', async () => {
    const { result } = await render()
    expect(result.current.groups).toEqual([
      { id: 'w1', name: 'api', agentStatus: 'blocked' },
      { id: 'w2', name: 'web', agentStatus: 'done' },
    ])
    expect(
      result.current.sessions.map((s) => [s.id, s.groupId, s.agentStatus]),
    ).toEqual([
      ['w1:t1', 'w1', 'blocked'],
      ['w1:t2', 'w1', undefined],
      ['w2:t1', 'w2', 'done'],
    ])
  })

  it('labels panes by agent, then title, then position', async () => {
    const { result } = await render()
    expect(result.current.sessions[0].panes).toEqual([
      {
        id: 'w1:p1',
        label: 'claude',
        hasAgent: true,
        agentName: 'claude',
        agentStatus: 'working',
      },
      {
        id: 'w1:p2',
        label: 'codex',
        hasAgent: true,
        agentName: 'codex',
        agentStatus: 'blocked',
      },
      { id: 'w1:p3', label: 'logs', hasAgent: false, agentStatus: undefined },
      { id: 'w1:p4', label: 'Pane 4', hasAgent: false, agentStatus: undefined },
    ])
  })

  it('switching tab stays on this device and is not undone by the poll', async () => {
    const { result } = await render()
    expect(result.current.activeSession.id).toBe('w1:t1')
    await act(async () => {
      await result.current.switchSession('w2:t1')
    })
    expect(mockSelectTab).not.toHaveBeenCalled()
    expect(result.current.activeSession.paneId).toBe('w2:p1')
    // The desktop moves to w1:t2; this device keeps its own tab
    mockSnapshot.extra = herdr('w1:t2')
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.activeSession.id).toBe('w2:t1')
  })

  it('switchSession opens a given pane of another tab', async () => {
    const { result } = await render()
    await act(async () => {
      await result.current.switchSession('w1:t2', 'w1:p5')
    })
    expect(result.current.activeSession.id).toBe('w1:t2')
    expect(result.current.activeSession.paneId).toBe('w1:p5')
  })

  it('switchSession opens a given pane of the tab on screen', async () => {
    const { result } = await render()
    await act(async () => {
      await result.current.switchSession('w1:t1', 'w1:p3')
    })
    expect(result.current.activeSession.paneId).toBe('w1:p3')
  })

  it('switchSession keeps the pane on screen when the tab is picked again', async () => {
    const { result } = await render()
    act(() => result.current.selectPane('w1:p3'))
    await act(async () => {
      await result.current.switchSession('w1:t1')
    })
    await act(async () => {
      await result.current.switchSession('w1:t1', 'w1:gone')
    })
    expect(result.current.activeSession.paneId).toBe('w1:p3')
  })

  it('switchSession falls back to the tab pane for an unknown pane', async () => {
    const { result } = await render()
    await act(async () => {
      await result.current.switchSession('w2:t1', 'w1:p2')
    })
    expect(result.current.activeSession.paneId).toBe('w2:p1')
  })

  it('selectPane streams another pane of the tab and keeps it on poll', async () => {
    const { result } = await render()
    act(() => result.current.selectPane('w1:p3'))
    expect(result.current.activeSession.paneId).toBe('w1:p3')
    expect(result.current.activeSession.hasAgent).toBe(false)
    act(() => result.current.selectPane('w1:p2'))
    expect(result.current.activeSession.hasAgent).toBe(true)
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.activeSession.paneId).toBe('w1:p2')
  })

  it('removePane closes a pane of the tab and falls back to the tab pane', async () => {
    mockClosePane.mockResolvedValue(true)
    const { result } = await render()
    act(() => result.current.selectPane('w1:p3'))
    // The server no longer lists the closed pane
    const snap = herdr()
    snap.groups[0].tabs[0].panes.splice(2, 1)
    mockSnapshot.extra = snap
    await act(async () => {
      await result.current.removePane('w1:p3')
    })
    expect(mockClosePane).toHaveBeenCalledWith('w1:p3')
    expect(result.current.activeSession.paneId).toBe('w1:p1')
    expect(result.current.activeSession.panes).toHaveLength(3)
  })

  it('removePane ignores a pane outside the tab or its last pane', async () => {
    const { result } = await render()
    await act(async () => {
      await result.current.removePane('w2:p1')
    })
    await act(async () => {
      await result.current.switchSession('w1:t2')
    })
    await act(async () => {
      await result.current.removePane('w1:p5')
    })
    expect(mockClosePane).not.toHaveBeenCalled()
  })

  it('selectPane ignores a pane outside the tab', async () => {
    const { result } = await render()
    act(() => result.current.selectPane('w2:p1'))
    expect(result.current.activeSession.paneId).toBe('w1:p1')
  })

  it('restores the pick from localStorage on next load', async () => {
    localStorage.setItem(
      'termote-selection-herdr',
      JSON.stringify({ tabId: 'w1:t1', paneId: 'w1:p4' }),
    )
    const { result } = await render()
    expect(result.current.activeSession.paneId).toBe('w1:p4')
  })

  it('falls back to the tab active pane when the saved pane is gone', async () => {
    localStorage.setItem(
      'termote-selection-herdr',
      JSON.stringify({ tabId: 'w1:t1', paneId: 'w1:gone' }),
    )
    const { result } = await render()
    expect(result.current.activeSession.paneId).toBe('w1:p1')
  })

  it('falls back to the server tab when the saved tab is gone', async () => {
    localStorage.setItem(
      'termote-selection-herdr',
      JSON.stringify({ tabId: 'w9:t1' }),
    )
    const { result } = await render()
    expect(result.current.activeSession.id).toBe('w1:t1')
  })

  it('ignores a corrupt saved pick', async () => {
    localStorage.setItem('termote-selection-herdr', 'not-json')
    const { result } = await render()
    expect(result.current.activeSession.id).toBe('w1:t1')
  })

  it('addSession creates the tab in the current group and shows it', async () => {
    const { result } = await render()
    await act(async () => {
      await result.current.switchSession('w2:t1')
    })
    const withNew = herdr()
    withNew.groups[1].tabs.push({
      id: 'w2:t9',
      name: 'new',
      active: false,
      panes: [pane('w2:p9', true)],
    })
    mockSnapshot.extra = withNew
    await act(async () => {
      await result.current.addSession('new', '🚀', 'Fresh')
    })
    expect(mockCreateTab).toHaveBeenCalledWith('new', 'w2')
    expect(result.current.activeSession.id).toBe('w2:t9')
    expect(result.current.activeSession.icon).toBe('🚀')
    const meta = JSON.parse(localStorage.getItem('termote-sessions')!)
    expect(meta).toEqual({
      'herdr:w2:t9': { icon: '🚀', description: 'Fresh' },
    })
  })

  it('addSession keeps the current tab when the server refuses', async () => {
    mockCreateTab.mockResolvedValue(null)
    const { result } = await render()
    await act(async () => {
      await result.current.addSession('bad name')
    })
    expect(result.current.activeSession.id).toBe('w1:t1')
    expect(localStorage.getItem('termote-sessions')).toBeNull()
  })

  it('addSession survives a failed request', async () => {
    mockCreateTab.mockRejectedValue(new Error('down'))
    const { result } = await render()
    await act(async () => {
      await result.current.addSession('new')
    })
    expect(result.current.activeSession.id).toBe('w1:t1')
  })

  it('renaming keeps metadata keyed by tab id', async () => {
    const { result } = await render()
    await act(async () => {
      await result.current.updateSession('w1:t2', { icon: '⭐' })
    })
    await act(async () => {
      await result.current.updateSession('w1:t2', { name: 'renamed' })
    })
    expect(mockRenameTab).toHaveBeenCalledWith('w1:t2', 'renamed')
    const meta = JSON.parse(localStorage.getItem('termote-sessions')!)
    expect(meta).toEqual({ 'herdr:w1:t2': { icon: '⭐', description: '' } })
  })

  it('removeSession drops metadata keyed by tab id', async () => {
    localStorage.setItem(
      'termote-sessions',
      JSON.stringify({ 'herdr:w1:t2': { icon: '⭐', description: '' } }),
    )
    const { result } = await render()
    await act(async () => {
      await result.current.removeSession('w1:t2')
    })
    expect(mockCloseTab).toHaveBeenCalledWith('w1:t2')
    expect(JSON.parse(localStorage.getItem('termote-sessions')!)).toEqual({})
  })

  const saved = () =>
    JSON.parse(localStorage.getItem('termote-selection-herdr') || 'null')

  // herdr() with an extra tab w2:t9 in the web workspace
  const withNewTab = () => {
    const snap = herdr()
    snap.groups[1].tabs.push({
      id: 'w2:t9',
      name: 'new',
      active: false,
      panes: [pane('w2:p9', true)],
    })
    return snap
  }

  it('without a saved pick, keeps the first tab shown when the desktop moves', async () => {
    const { result } = await render()
    expect(saved()).toEqual({ tabId: 'w1:t1', groupId: 'w1', paneId: 'w1:p1' })
    // Desktop switches tab and focuses another pane in the shown tab
    const moved = herdr('w1:t2')
    moved.groups[0].tabs[0].panes[0].active = false
    moved.groups[0].tabs[0].panes[1].active = true
    mockSnapshot.extra = moved
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.activeSession.id).toBe('w1:t1')
    expect(result.current.activeSession.paneId).toBe('w1:p1')
  })

  it('a closed tab gives way to another tab of the same group', async () => {
    const { result } = await render()
    await act(async () => {
      await result.current.switchSession('w2:t1')
    })
    mockSnapshot.extra = withNewTab()
    await act(async () => {
      await result.current.refreshSessions()
    })
    await act(async () => {
      await result.current.switchSession('w2:t9')
    })
    // w2:t9 is closed; the server's first active tab is in w1
    mockSnapshot.extra = herdr()
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.activeSession.id).toBe('w2:t1')
    expect(saved().tabId).toBe('w2:t1')
  })

  it('a tab gone with its whole group falls back to the server pick', async () => {
    localStorage.setItem(
      'termote-selection-herdr',
      JSON.stringify({ tabId: 'w9:t1', groupId: 'w9' }),
    )
    const { result } = await render()
    expect(result.current.activeSession.id).toBe('w1:t1')
  })

  it('shows nothing when herdr has no tab at all', async () => {
    mockSnapshot.extra = {
      ...herdr(),
      groups: [{ id: 'w1', name: 'api', tabs: [] }],
    }
    const { result } = await render()
    expect(result.current.activeSession.name).toBe('Loading...')
  })

  it('a poll sent before a new tab was picked does not undo the pick', async () => {
    const { result } = await render()
    // A poll is in flight with a snapshot taken before the tab existed
    let release = () => {}
    mockFetchTabs.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r([])
        }),
    )
    let poll: Promise<void> = Promise.resolve()
    act(() => {
      poll = result.current.refreshSessions()
    })
    mockSnapshot.extra = withNewTab()
    await act(async () => {
      await result.current.addSession('new')
    })
    expect(result.current.activeSession.id).toBe('w2:t9')
    mockSnapshot.extra = herdr()
    await act(async () => {
      release()
      await poll
    })
    expect(result.current.activeSession.id).toBe('w2:t9')
    expect(saved().tabId).toBe('w2:t9')
  })

  it('a new tab remembers the pane it first shows', async () => {
    const { result } = await render()
    mockSnapshot.extra = withNewTab()
    await act(async () => {
      await result.current.addSession('new')
    })
    // The stored group follows where the tab really is
    expect(saved()).toEqual({ tabId: 'w2:t9', groupId: 'w2', paneId: 'w2:p9' })
  })
})

describe('useLocalSessions group create on herdr', () => {
  const ws = (id: string, tab: string) => ({
    id,
    name: id,
    tabs: [
      {
        id: tab,
        name: 'shell',
        active: true,
        panes: [{ id: `${tab}:p`, active: true }],
      },
    ],
  })
  const caps = { clientSideSelect: true, copyMode: false }

  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockSnapshot.extra = { backend: 'herdr', caps, groups: [ws('w1', 'w1:t1')] }
  })

  it('keeps the pick until the new workspace is reported, then shows it', async () => {
    mockCreateGroup.mockResolvedValue('w9')
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.createGroup('api')
    })
    // Not reported yet: nothing moves.
    expect(result.current.activeSession.id).toBe('w1:t1')
    mockSnapshot.extra = {
      backend: 'herdr',
      caps,
      groups: [ws('w1', 'w1:t1'), ws('w9', 'w9:t1')],
    }
    await act(async () => {
      await result.current.refreshSessions()
    })
    expect(result.current.activeSession.id).toBe('w9:t1')
  })

  it('stops waiting for a workspace that never shows', async () => {
    mockCreateGroup.mockResolvedValue('w9')
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.createGroup('api')
    })
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await result.current.refreshSessions()
      })
    }
    expect(result.current.activeSession.id).toBe('w1:t1')
    expect(
      JSON.parse(localStorage.getItem('termote-selection-herdr')!).groupId,
    ).toBe('w1')
  })
})
