import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted — use vi.hoisted to declare mocks before the factory runs
const {
  mockFetchWindows,
  mockCreateWindow,
  mockKillWindow,
  mockRenameWindow,
  mockSelectWindow,
} = vi.hoisted(() => ({
  mockFetchWindows: vi.fn(),
  mockCreateWindow: vi.fn(),
  mockKillWindow: vi.fn(),
  mockRenameWindow: vi.fn(),
  mockSelectWindow: vi.fn(),
}))

vi.mock('./use-tmux-api', () => ({
  fetchWindows: mockFetchWindows,
  createWindow: mockCreateWindow,
  killWindow: mockKillWindow,
  renameWindow: mockRenameWindow,
  selectWindow: mockSelectWindow,
}))

import { useLocalSessions } from './use-local-sessions'

const WIN_SHELL = { id: 0, name: 'shell', active: true }
const WIN_VIM = { id: 1, name: 'vim', active: false }

describe('useLocalSessions', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockFetchWindows.mockResolvedValue([WIN_SHELL])
    mockCreateWindow.mockResolvedValue(true)
    mockKillWindow.mockResolvedValue(true)
    mockRenameWindow.mockResolvedValue(true)
    mockSelectWindow.mockResolvedValue(true)
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
    mockFetchWindows.mockResolvedValue([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.activeSession.name).toBe('shell')
  })

  it('falls back to first session when none is active', async () => {
    mockFetchWindows.mockResolvedValue([
      { id: 0, name: 'vim', active: false },
      { id: 1, name: 'bash', active: false },
    ])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.activeSession.name).toBe('vim')
  })

  it('creates default window when fetchWindows returns empty', async () => {
    mockFetchWindows
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(mockCreateWindow).toHaveBeenCalledWith('shell')
    expect(result.current.sessions[0].name).toBe('shell')
  })

  it('uses fallback session when API throws on first load', async () => {
    mockFetchWindows.mockRejectedValue(new Error('API down'))
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.isServerReachable).toBe(false)
    expect(result.current.isReady).toBe(true)
    expect(result.current.sessions[0].name).toBe('shell')
    expect(result.current.activeSession.name).toBe('shell')
  })

  it('does not reset sessions on subsequent API errors after ready', async () => {
    mockFetchWindows
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
    mockFetchWindows.mockReturnValue(new Promise(() => {})) // never resolves
    const { result } = renderHook(() => useLocalSessions(1))
    expect(result.current.activeSession.name).toBe('Loading...')
  })

  it('switchSession selects a different session', async () => {
    mockFetchWindows.mockResolvedValue([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.switchSession('1')
    })
    expect(mockSelectWindow).toHaveBeenCalledWith('1')
    expect(result.current.activeSession.name).toBe('vim')
  })

  it('switchSession does nothing when session not found', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.switchSession('999')
    })
    expect(mockSelectWindow).not.toHaveBeenCalled()
  })

  it('switchSession does nothing when already active', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.switchSession('0')
    })
    expect(mockSelectWindow).not.toHaveBeenCalled()
  })

  it('addSession creates window and refreshes', async () => {
    mockFetchWindows
      .mockResolvedValueOnce([WIN_SHELL])
      .mockResolvedValueOnce([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.addSession('vim', '🖥️', 'Editor')
    })
    expect(mockCreateWindow).toHaveBeenCalledWith('vim')
    expect(result.current.sessions).toHaveLength(2)
  })

  it('addSession stores metadata in localStorage', async () => {
    mockFetchWindows
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
    mockFetchWindows
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
    mockFetchWindows
      .mockResolvedValueOnce([WIN_SHELL, WIN_VIM])
      .mockResolvedValueOnce([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.removeSession('1')
    })
    expect(mockKillWindow).toHaveBeenCalledWith('1')
    expect(result.current.sessions).toHaveLength(1)
  })

  it('removeSession does nothing when only one session', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.removeSession('0')
    })
    expect(mockKillWindow).not.toHaveBeenCalled()
  })

  it('removeSession does nothing when session not found', async () => {
    mockFetchWindows.mockResolvedValue([WIN_SHELL, WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.removeSession('999')
    })
    expect(mockKillWindow).not.toHaveBeenCalled()
  })

  it('updateSession updates name and renames tmux window', async () => {
    mockFetchWindows.mockResolvedValue([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.updateSession('0', { name: 'renamed' })
    })
    expect(mockRenameWindow).toHaveBeenCalledWith('0', 'renamed')
    expect(result.current.sessions[0].name).toBe('renamed')
  })

  it('updateSession updates icon and description without renaming', async () => {
    mockFetchWindows.mockResolvedValue([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.updateSession('0', {
        icon: '🔥',
        description: 'Hot session',
      })
    })
    expect(mockRenameWindow).not.toHaveBeenCalled()
    expect(result.current.sessions[0].icon).toBe('🔥')
    expect(result.current.sessions[0].description).toBe('Hot session')
  })

  it('updateSession does nothing when session not found', async () => {
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    await act(async () => {
      await result.current.updateSession('999', { name: 'ghost' })
    })
    expect(mockRenameWindow).not.toHaveBeenCalled()
  })

  it('updateSession also updates activeSession when it matches', async () => {
    mockFetchWindows.mockResolvedValue([WIN_SHELL])
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
    mockFetchWindows.mockResolvedValue([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.sessions[0].icon).toBe('🐚')
    expect(result.current.sessions[0].description).toBe('My shell')
  })

  it('uses default icon when no metadata exists for a window', async () => {
    mockFetchWindows.mockResolvedValue([WIN_VIM])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.sessions[0].icon).toBe('📺')
  })

  it('handles corrupt localStorage metadata gracefully', async () => {
    localStorage.setItem('termote-sessions', 'not-json')
    mockFetchWindows.mockResolvedValue([WIN_SHELL])
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    expect(result.current.sessions[0].name).toBe('shell')
  })

  it('activeSession falls back to null (Loading placeholder) when applyWindows receives empty array', async () => {
    // applyWindows with empty array: mapped=[], active=undefined, mapped[0]=undefined → ?? null → null
    // This hits the `?? null` branch in: active ? ... : (mapped[0] ?? null)
    mockFetchWindows.mockResolvedValueOnce([]).mockResolvedValueOnce([]) // both fetches return empty
    mockCreateWindow.mockResolvedValue(true)
    const { result } = renderHook(() => useLocalSessions(1))
    await act(async () => {})
    // activeSession is null internally → returns the Loading placeholder from the return statement
    expect(result.current.activeSession.name).toBe('Loading...')
  })

  it('updateSession updates only the matching session in sessions array (non-active session)', async () => {
    mockFetchWindows.mockResolvedValue([WIN_SHELL, WIN_VIM])
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
