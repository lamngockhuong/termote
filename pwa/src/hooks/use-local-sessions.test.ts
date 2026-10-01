import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted — use vi.hoisted to declare mocks before the factory runs
const {
  mockFetchTabs,
  mockCreateTab,
  mockCloseTab,
  mockRenameTab,
  mockSelectTab,
  mockSnapshot,
} = vi.hoisted(() => ({
  // Overrides merged into every snapshot (backend, caps, groups).
  mockSnapshot: { extra: {} as Record<string, unknown> },
  mockFetchTabs: vi.fn(),
  mockCreateTab: vi.fn(),
  mockCloseTab: vi.fn(),
  mockRenameTab: vi.fn(),
  mockSelectTab: vi.fn(),
}))

vi.mock('./use-mux-api', () => ({
  fetchSnapshot: async () => ({
    apiVersion: 1,
    backend: 'tmux',
    caps: { clientSideSelect: false, copyMode: true },
    groups: [{ id: 'main', name: 'main', tabs: await mockFetchTabs() }],
    ...mockSnapshot.extra,
  }),
  createTab: mockCreateTab,
  closeTab: mockCloseTab,
  renameTab: mockRenameTab,
  selectTab: mockSelectTab,
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

  it('tmux ignores selectPane', async () => {
    mockFetchTabs.mockResolvedValue([
      { ...WIN_SHELL, panes: [{ id: '0', active: true }] },
    ])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    act(() => result.current.selectPane('0'))
    expect(localStorage.getItem('termote-selection-tmux')).toBeNull()
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
