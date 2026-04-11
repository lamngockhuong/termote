import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import { SettingsMenu } from './settings-menu'

function renderWithTheme(props = {}) {
  const defaultProps = {
    onOpenAbout: vi.fn(),
    onOpenHelp: vi.fn(),
    onOpenSettings: vi.fn(),
    ...props,
  }
  return {
    ...render(
      <ThemeProvider>
        <SettingsMenu {...defaultProps} />
      </ThemeProvider>,
    ),
    props: defaultProps,
  }
}

describe('SettingsMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Mock serviceWorker
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        getRegistrations: vi
          .fn()
          .mockResolvedValue([{ unregister: vi.fn().mockResolvedValue(true) }]),
      },
      configurable: true,
      writable: true,
    })

    // Mock caches
    Object.defineProperty(window, 'caches', {
      value: {
        keys: vi.fn().mockResolvedValue(['cache1']),
        delete: vi.fn().mockResolvedValue(true),
      },
      configurable: true,
      writable: true,
    })

    // Mock location.reload
    Object.defineProperty(window, 'location', {
      value: { reload: vi.fn() },
      configurable: true,
      writable: true,
    })
  })

  it('renders settings button', () => {
    renderWithTheme()
    expect(screen.getByLabelText('Settings')).toBeInTheDocument()
  })

  it('dropdown is not visible initially', () => {
    renderWithTheme()
    expect(screen.queryByText('Preferences')).not.toBeInTheDocument()
  })

  it('opens dropdown on settings button click', () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByText('Preferences')).toBeInTheDocument()
    expect(screen.getByText('Usage Guide')).toBeInTheDocument()
    expect(screen.getByText('About Termote')).toBeInTheDocument()
  })

  it('sets aria-expanded correctly', () => {
    renderWithTheme()
    const btn = screen.getByLabelText('Settings')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes dropdown on second click', () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.click(screen.getByLabelText('Settings'))
    expect(screen.queryByText('Preferences')).not.toBeInTheDocument()
  })

  it('calls onOpenSettings and closes on Preferences click', () => {
    const { props } = renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.click(screen.getByText('Preferences'))
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Preferences')).not.toBeInTheDocument()
  })

  it('calls onOpenHelp and closes on Usage Guide click', () => {
    const { props } = renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.click(screen.getByText('Usage Guide'))
    expect(props.onOpenHelp).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Usage Guide')).not.toBeInTheDocument()
  })

  it('calls onOpenAbout and closes on About Termote click', () => {
    const { props } = renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.click(screen.getByText('About Termote'))
    expect(props.onOpenAbout).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('About Termote')).not.toBeInTheDocument()
  })

  it('closes dropdown when clicking outside', () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByText('Preferences')).toBeInTheDocument()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByText('Preferences')).not.toBeInTheDocument()
  })

  it('does not close when clicking inside the menu', () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    const menu = screen
      .getByText('Preferences')
      .closest('div[class*="absolute"]')!
    fireEvent.mouseDown(menu)
    expect(screen.getByText('Preferences')).toBeInTheDocument()
  })

  it('outside click listener is removed when dropdown closes', () => {
    const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener')
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.click(screen.getByLabelText('Settings'))
    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      'mousedown',
      expect.any(Function),
    )
    removeEventListenerSpy.mockRestore()
  })

  it('shows Clear Cache & Reload button', () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByText('Clear Cache & Reload')).toBeInTheDocument()
  })

  it('clears cache and reloads when clear cache button clicked', async () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.click(screen.getByText('Clear Cache & Reload'))
    // Shows clearing state
    expect(screen.getByText('Clearing...')).toBeInTheDocument()
    await waitFor(() => {
      expect(window.location.reload).toHaveBeenCalled()
    })
  })

  it('disables clear cache button while clearing', async () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    const clearBtn = screen.getByText('Clear Cache & Reload')
    fireEvent.click(clearBtn)
    const clearingBtn = screen.getByText('Clearing...')
    expect(clearingBtn).toBeDisabled()
  })

  it('handles missing serviceWorker gracefully (sw returns empty registrations)', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { getRegistrations: vi.fn().mockResolvedValue([]) },
      configurable: true,
      writable: true,
    })
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.click(screen.getByText('Clear Cache & Reload'))
    await waitFor(() => {
      expect(window.location.reload).toHaveBeenCalled()
    })
  })

  it('handles missing caches gracefully (caches returns empty list)', async () => {
    Object.defineProperty(window, 'caches', {
      value: { keys: vi.fn().mockResolvedValue([]), delete: vi.fn() },
      configurable: true,
      writable: true,
    })
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.click(screen.getByText('Clear Cache & Reload'))
    await waitFor(() => {
      expect(window.location.reload).toHaveBeenCalled()
    })
  })

  it('handles absence of serviceWorker API gracefully', async () => {
    // Remove serviceWorker from navigator to hit the false branch of `'serviceWorker' in navigator`
    const descriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'serviceWorker',
    )
    Reflect.deleteProperty(navigator, 'serviceWorker')
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.click(screen.getByText('Clear Cache & Reload'))
    await waitFor(() => {
      expect(window.location.reload).toHaveBeenCalled()
    })
    // Restore
    if (descriptor) {
      Object.defineProperty(navigator, 'serviceWorker', descriptor)
    }
  })

  it('handles absence of caches API gracefully (false branch of caches in window)', async () => {
    // Remove caches from window to hit the false branch of `'caches' in window`
    const descriptor = Object.getOwnPropertyDescriptor(window, 'caches')
    Reflect.deleteProperty(
      window as typeof window & { caches?: unknown },
      'caches',
    )
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.click(screen.getByText('Clear Cache & Reload'))
    await waitFor(() => {
      expect(window.location.reload).toHaveBeenCalled()
    })
    // Restore
    if (descriptor) {
      Object.defineProperty(window, 'caches', descriptor)
    }
  })

  it('renders theme toggle inside dropdown', () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('Settings'))
    expect(screen.getByLabelText('Light theme')).toBeInTheDocument()
    expect(screen.getByLabelText('Dark theme')).toBeInTheDocument()
    expect(screen.getByLabelText('System theme')).toBeInTheDocument()
  })
})
