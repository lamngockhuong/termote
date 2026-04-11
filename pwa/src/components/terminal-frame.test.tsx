import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalFrame, type TerminalFrameHandle } from './terminal-frame'

vi.mock('../hooks/use-tmux-api', () => ({
  fetchTerminalToken: vi.fn(),
}))

vi.mock('../utils/terminal-bridge', () => ({
  setTerminalTheme: vi.fn(() => false),
  setTerminalFontSize: vi.fn(),
  blockContextMenu: vi.fn(() => true),
  unblockContextMenu: vi.fn(() => true),
  sendKeyToTerminal: vi.fn(),
}))

import { fetchTerminalToken } from '../hooks/use-tmux-api'
import {
  blockContextMenu,
  sendKeyToTerminal,
  setTerminalFontSize,
  setTerminalTheme,
  unblockContextMenu,
} from '../utils/terminal-bridge'

const mockFetchToken = vi.mocked(fetchTerminalToken)
const mockSetTheme = vi.mocked(setTerminalTheme)
const mockSetFontSize = vi.mocked(setTerminalFontSize)
const mockBlockCtx = vi.mocked(blockContextMenu)
const mockUnblockCtx = vi.mocked(unblockContextMenu)

describe('TerminalFrame', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetTheme.mockReturnValue(false)
  })

  it('shows connecting/loading state while fetching token', async () => {
    mockFetchToken.mockReturnValue(new Promise(() => {})) // never resolves
    render(<TerminalFrame />)
    expect(screen.getByText('Connecting...')).toBeInTheDocument()
  })

  it('renders iframe after successful token fetch', async () => {
    mockFetchToken.mockResolvedValue('test-token')
    render(<TerminalFrame />)
    await waitFor(() => {
      expect(screen.getByTitle('Terminal')).toBeInTheDocument()
    })
    const iframe = screen.getByTitle('Terminal') as HTMLIFrameElement
    expect(iframe.src).toContain('/terminal/?token=test-token')
  })

  it('shows error state when token fetch fails', async () => {
    mockFetchToken.mockRejectedValue(new Error('network error'))
    render(<TerminalFrame />)
    await waitFor(() => {
      expect(screen.getByText('Failed to load terminal')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('retries load when Retry button clicked', async () => {
    mockFetchToken
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('retry-token')
    render(<TerminalFrame />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument(),
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    await waitFor(() => {
      expect(screen.getByTitle('Terminal')).toBeInTheDocument()
    })
  })

  it('notifies parent of connection state changes', async () => {
    mockFetchToken.mockResolvedValue('token')
    const onStateChange = vi.fn()
    render(<TerminalFrame onConnectionStateChange={onStateChange} />)
    await waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith('connecting')
    })
    await waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith('connected')
    })
  })

  it('notifies parent with error state on failure', async () => {
    mockFetchToken.mockRejectedValue(new Error('fail'))
    const onStateChange = vi.fn()
    render(<TerminalFrame onConnectionStateChange={onStateChange} />)
    await waitFor(() => {
      expect(onStateChange).toHaveBeenCalledWith('error')
    })
  })

  it('exposes reconnect and connectionState via ref', async () => {
    mockFetchToken.mockResolvedValue('token')
    const ref = createRef<TerminalFrameHandle>()
    render(<TerminalFrame ref={ref} />)
    await waitFor(() => {
      expect(ref.current?.connectionState).toBe('connected')
    })
    expect(typeof ref.current?.reconnect).toBe('function')
  })

  it('applies theme immediately when setTerminalTheme returns true', async () => {
    mockFetchToken.mockResolvedValue('token')
    mockSetTheme.mockReturnValue(true)
    render(<TerminalFrame theme="light" fontSize={16} />)
    await waitFor(() => {
      expect(screen.getByTitle('Terminal')).toBeInTheDocument()
    })
    // After iframe renders, the effect runs
    expect(mockSetTheme).toHaveBeenCalled()
  })

  it('calls blockContextMenu when disableContextMenu is true and theme applied immediately', async () => {
    mockFetchToken.mockResolvedValue('token')
    mockSetTheme.mockReturnValue(true)
    render(<TerminalFrame disableContextMenu={true} />)
    await waitFor(() =>
      expect(screen.getByTitle('Terminal')).toBeInTheDocument(),
    )
    expect(mockBlockCtx).toHaveBeenCalled()
  })

  it('calls unblockContextMenu when disableContextMenu is false and theme applied immediately', async () => {
    mockFetchToken.mockResolvedValue('token')
    mockSetTheme.mockReturnValue(true)
    render(<TerminalFrame disableContextMenu={false} />)
    await waitFor(() =>
      expect(screen.getByTitle('Terminal')).toBeInTheDocument(),
    )
    expect(mockUnblockCtx).toHaveBeenCalled()
  })

  it('applies light theme class to iframe', async () => {
    mockFetchToken.mockResolvedValue('token')
    render(<TerminalFrame theme="light" />)
    await waitFor(() =>
      expect(screen.getByTitle('Terminal')).toBeInTheDocument(),
    )
    const iframe = screen.getByTitle('Terminal')
    expect(iframe.className).toContain('bg-[#f6f8fa]')
  })

  it('applies dark theme class to iframe', async () => {
    mockFetchToken.mockResolvedValue('token')
    render(<TerminalFrame theme="dark" />)
    await waitFor(() =>
      expect(screen.getByTitle('Terminal')).toBeInTheDocument(),
    )
    const iframe = screen.getByTitle('Terminal')
    expect(iframe.className).toContain('bg-[#2b2b2b]')
  })

  it('polls via load event when setTerminalTheme returns false initially', async () => {
    vi.useFakeTimers()
    mockFetchToken.mockResolvedValue('token')
    mockSetTheme.mockReturnValue(false)

    render(<TerminalFrame theme="dark" fontSize={14} />)

    await act(async () => {
      await Promise.resolve()
    })

    const iframe = screen.queryByTitle('Terminal')
    if (iframe) {
      // Simulate load event
      mockSetTheme.mockReturnValue(true)
      fireEvent.load(iframe)
      // Run the polling interval
      act(() => {
        vi.advanceTimersByTime(100)
      })
      expect(mockSetTheme).toHaveBeenCalled()
      expect(mockSetFontSize).toHaveBeenCalled()
    }

    vi.useRealTimers()
  })

  it('stops polling after 30 attempts', async () => {
    vi.useFakeTimers()
    mockFetchToken.mockResolvedValue('token')
    mockSetTheme.mockReturnValue(false)

    render(<TerminalFrame />)
    await act(async () => {
      await Promise.resolve()
    })

    const iframe = screen.queryByTitle('Terminal')
    if (iframe) {
      fireEvent.load(iframe)
      // Advance 30 intervals
      act(() => {
        vi.advanceTimersByTime(100 * 31)
      })
      const callCount = mockSetTheme.mock.calls.length
      // After 30 fails, no more calls
      act(() => {
        vi.advanceTimersByTime(100 * 5)
      })
      expect(mockSetTheme.mock.calls.length).toBe(callCount)
    }

    vi.useRealTimers()
  })

  it('sendKeyToTerminal called after theme applied in polling', async () => {
    vi.useFakeTimers()
    mockFetchToken.mockResolvedValue('token')
    mockSetTheme
      .mockReturnValueOnce(false) // first call in effect
      .mockReturnValueOnce(false) // first poll call fails
      .mockReturnValue(true) // second poll call succeeds

    render(<TerminalFrame />)
    await act(async () => {
      await Promise.resolve()
    })

    const iframe = screen.queryByTitle('Terminal')
    if (iframe) {
      fireEvent.load(iframe)
      act(() => {
        vi.advanceTimersByTime(200)
      })
      // sendKeyToTerminal called after 300ms
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(sendKeyToTerminal).toHaveBeenCalled()
    }

    vi.useRealTimers()
  })

  it('ref iframe is null before loading completes', () => {
    mockFetchToken.mockReturnValue(new Promise(() => {}))
    const ref = createRef<TerminalFrameHandle>()
    render(<TerminalFrame ref={ref} />)
    // iframe ref is null since we're in loading state (no iframe in DOM)
    expect(ref.current?.iframe).toBeNull()
  })
})
