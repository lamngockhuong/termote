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

  const open = () =>
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
  const item = (name: string) => screen.getByRole('menuitem', { name })

  it('renders the overflow menu button', () => {
    renderWithTheme()
    expect(screen.getByLabelText('More')).toHaveAttribute(
      'aria-haspopup',
      'menu',
    )
  })

  it('menu is not visible initially', () => {
    renderWithTheme()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens the menu with the dialogs and the theme', () => {
    renderWithTheme()
    open()
    expect(item('Settings')).toBeInTheDocument()
    expect(item('Help & gestures')).toBeInTheDocument()
    expect(item('About')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument()
  })

  it('sets aria-expanded correctly', () => {
    renderWithTheme()
    const btn = screen.getByLabelText('More')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes the menu on second click', () => {
    renderWithTheme()
    open()
    open()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it.each([
    ['Settings', 'onOpenSettings'],
    ['Help & gestures', 'onOpenHelp'],
    ['About', 'onOpenAbout'],
  ] as const)('%s calls %s and closes the menu', (name, callback) => {
    const { props } = renderWithTheme()
    open()
    fireEvent.click(item(name))
    expect(props[callback]).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes the menu on a press outside', () => {
    renderWithTheme()
    open()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('stays open on a press inside the menu', () => {
    renderWithTheme()
    open()
    fireEvent.pointerDown(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('theme items pick the theme and keep the menu open', () => {
    renderWithTheme()
    open()
    const radio = (name: string) => screen.getByRole('menuitemradio', { name })
    expect(radio('System')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(radio('Dark'))
    expect(radio('Dark')).toHaveAttribute('aria-checked', 'true')
    expect(radio('System')).toHaveAttribute('aria-checked', 'false')
    expect(document.documentElement).toHaveClass('dark')
    fireEvent.click(radio('Light'))
    expect(radio('Light')).toHaveAttribute('aria-checked', 'true')
  })

  it('leaves out font size and Copy link unless given', () => {
    renderWithTheme()
    open()
    expect(screen.queryByText(/Font size/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: 'Copy link' }),
    ).not.toBeInTheDocument()
  })

  it('font size items change the size and keep the menu open', () => {
    const onDecrease = vi.fn()
    const onIncrease = vi.fn()
    renderWithTheme({ fontSize: { value: 14, onDecrease, onIncrease } })
    open()
    expect(
      screen.getByRole('group', { name: 'Font size · 14' }),
    ).toBeInTheDocument()
    fireEvent.click(item('Decrease font size'))
    fireEvent.click(item('Increase font size'))
    expect(onDecrease).toHaveBeenCalledOnce()
    expect(onIncrease).toHaveBeenCalledOnce()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('Copy link calls onCopyLink', () => {
    const onCopyLink = vi.fn()
    renderWithTheme({ onCopyLink })
    open()
    fireEvent.click(item('Copy link'))
    expect(onCopyLink).toHaveBeenCalledOnce()
  })

  it('clears cache and reloads when clear cache button clicked', async () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Clear cache & reload' }),
    )
    // Shows clearing state
    expect(screen.getByText('Clearing...')).toBeInTheDocument()
    await waitFor(() => {
      expect(window.location.reload).toHaveBeenCalled()
    })
  })

  it('disables clear cache button while clearing', async () => {
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('More'))
    const clearBtn = screen.getByRole('menuitem', {
      name: 'Clear cache & reload',
    })
    fireEvent.click(clearBtn)
    const clearingBtn = screen.getByRole('menuitem', { name: 'Clearing...' })
    expect(clearingBtn).toBeDisabled()
  })

  it('handles missing serviceWorker gracefully (sw returns empty registrations)', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { getRegistrations: vi.fn().mockResolvedValue([]) },
      configurable: true,
      writable: true,
    })
    renderWithTheme()
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Clear cache & reload' }),
    )
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
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Clear cache & reload' }),
    )
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
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Clear cache & reload' }),
    )
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
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Clear cache & reload' }),
    )
    await waitFor(() => {
      expect(window.location.reload).toHaveBeenCalled()
    })
    // Restore
    if (descriptor) {
      Object.defineProperty(window, 'caches', descriptor)
    }
  })
})
