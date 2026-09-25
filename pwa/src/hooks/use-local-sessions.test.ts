import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted — use vi.hoisted to declare mocks before the factory runs
const {
  mockFetchTabs,
  mockCreateTab,
  mockCloseTab,
  mockRenameTab,
  mockSelectTab,
} = vi.hoisted(() => ({
  mockFetchTabs: vi.fn(),
  mockCreateTab: vi.fn(),
  mockCloseTab: vi.fn(),
  mockRenameTab: vi.fn(),
  mockSelectTab: vi.fn(),
}))

vi.mock('./use-mux-api', () => ({
  fetchTabs: mockFetchTabs,
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
    expect(mockCreateTab).toHaveBeenCalledWith('vim')
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
    expect(meta['vim'].icon).toBe('🖥️')
    expect(meta['vim'].description).toBe('My editor')
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
    expect(meta['vim'].icon).toBe('📺')
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
})
