import { fireEvent, render, screen } from '@testing-library/react'
import { MessageSquare, SquareTerminal } from 'lucide-react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import type { Session } from '../types/session'
import { AppHeader } from './app-header'

const SESSIONS: Session[] = [
  { id: '1', name: 'Shell', icon: '💻', description: 'Terminal' },
  { id: '2', name: 'Code', icon: '🤖', description: '' },
]

type Props = ComponentProps<typeof AppHeader>

function renderHeader(overrides: Partial<Props> = {}) {
  const props = headerProps(overrides)
  render(
    <ThemeProvider>
      <AppHeader {...props} />
    </ThemeProvider>,
  )
  return props
}

function headerProps(overrides: Partial<Props> = {}): Props {
  return {
    isMobile: false,
    session: SESSIONS[0],
    groupSessions: SESSIONS,
    groupName: 'main',
    showSessionTabs: true,
    canRemoveTab: true,
    onSelectTab: vi.fn(),
    onAddTab: vi.fn(),
    onRemoveTab: vi.fn(),
    connectionState: 'connected',
    onRetry: vi.fn(),
    sessionsOpen: false,
    onOpenSessions: vi.fn(),
    fontSize: 14,
    showFontSize: true,
    onDecreaseFont: vi.fn(),
    onIncreaseFont: vi.fn(),
    isFullscreen: false,
    onToggleFullscreen: vi.fn(),
    views: [{ id: 'terminal', label: 'Terminal', Icon: SquareTerminal }],
    viewId: 'terminal',
    onViewChange: vi.fn(),
    viewPanelId: (id) => `panel-${id}`,
    menu: {
      onOpenAbout: vi.fn(),
      onOpenHelp: vi.fn(),
      onOpenSettings: vi.fn(),
    },
    ...overrides,
  }
}

const TWO_VIEWS = [
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
]

describe('AppHeader — usage chip', () => {
  it('shows the chip it is given, on desktop and mobile', () => {
    for (const isMobile of [false, true]) {
      const { unmount } = render(
        <ThemeProvider>
          <AppHeader
            {...headerProps({ isMobile })}
            usageChip={<span>ctx 72%</span>}
          />
        </ThemeProvider>,
      )
      expect(screen.getByText('ctx 72%')).toBeInTheDocument()
      unmount()
    }
  })
})

describe('AppHeader — pane menu', () => {
  it('shows the Pane menu it is given, on desktop and mobile, and none without', () => {
    for (const isMobile of [false, true]) {
      const { unmount } = render(
        <ThemeProvider>
          <AppHeader
            {...headerProps({ isMobile })}
            paneMenu={<button type="button">Pane</button>}
          />
        </ThemeProvider>,
      )
      expect(screen.getByRole('button', { name: 'Pane' })).toBeInTheDocument()
      unmount()
    }
    renderHeader()
    expect(screen.queryByRole('button', { name: 'Pane' })).toBeNull()
  })

  it('sits right of the font size on desktop', () => {
    render(
      <ThemeProvider>
        <AppHeader
          {...headerProps({ isMobile: false, showFontSize: true })}
          paneMenu={<button type="button">Pane</button>}
        />
      </ThemeProvider>,
    )
    const font = screen.getByRole('button', { name: 'Increase font size' })
    const pane = screen.getByRole('button', { name: 'Pane' })
    expect(
      font.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

describe('AppHeader — desktop', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('puts the session tabs in the header row', () => {
    const props = renderHeader()
    expect(screen.getByRole('tablist', { name: 'Sessions' })).toBeVisible()
    fireEvent.click(screen.getByRole('tab', { name: /Code/ }))
    expect(props.onSelectTab).toHaveBeenCalledWith('2')
    fireEvent.click(screen.getByRole('button', { name: 'Add session' }))
    expect(props.onAddTab).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Close Code' }))
    expect(props.onRemoveTab).toHaveBeenCalledWith('2')
  })

  it('shows the tabs of another group as a new list: none fades in or out', () => {
    // The tabs' transition, as the stylesheet gives it in a browser
    const real = window.getComputedStyle
    const style = vi
      .spyOn(window, 'getComputedStyle')
      .mockImplementation((el) =>
        el.getAttribute('draggable') !== null || el.classList.contains('group')
          ? ({
              transitionDuration: '150ms',
              transitionDelay: '0s',
            } as CSSStyleDeclaration)
          : real(el),
      )
    const other: Session[] = [
      { id: '3', name: 'Web', icon: '🌐', description: '', groupId: 'g2' },
    ]
    const header = (p: Props) => (
      <ThemeProvider>
        <AppHeader {...p} />
      </ThemeProvider>
    )
    const props = headerProps()
    const { rerender } = render(header(props))
    rerender(header({ ...props, session: other[0], groupSessions: other }))
    expect(screen.queryByText('Shell')).toBeNull()
    expect(screen.getByText('Web').closest('.group')).not.toHaveClass(
      'motion-safe:starting:opacity-0',
    )
    style.mockRestore()
  })

  it('leads the row with the brand mark while the sidebar is collapsed', () => {
    renderHeader({ showBrand: true })
    expect(screen.getByRole('banner').firstElementChild).toBe(
      screen.getByTestId('brand-mark'),
    )
    expect(screen.getByTestId('brand-mark')).toHaveClass('owl-blink-hover')
  })

  it('leaves the brand to the expanded sidebar', () => {
    renderHeader()
    expect(screen.queryByTestId('brand-mark')).toBeNull()
  })

  it('sits below the status bar and grows with touch-sized controls', () => {
    renderHeader()
    const header = screen.getByRole('banner')
    expect(header).toHaveClass('min-h-11')
    expect(header).not.toHaveClass('h-11')
    expect(header).toHaveClass('pt-[env(safe-area-inset-top)]')
  })

  it('names the session only, with its description, when tabs are off', () => {
    renderHeader({ showSessionTabs: false })
    expect(screen.queryByRole('tablist', { name: 'Sessions' })).toBeNull()
    expect(screen.getByTitle('Shell - Terminal')).toHaveTextContent(
      '💻ShellTerminal',
    )
  })

  it('shows the hidden characters of the session name', () => {
    renderHeader({
      showSessionTabs: false,
      session: { ...SESSIONS[0], name: 'Sh\u202eell' },
    })
    expect(screen.getByTitle('Sh⟨U+202E⟩ell - Terminal')).toHaveTextContent(
      '💻Sh⟨U+202E⟩ellTerminal',
    )
  })

  it('leaves out an empty description from the title', () => {
    renderHeader({ showSessionTabs: false, session: SESSIONS[1] })
    expect(screen.getByTitle('Code')).toHaveTextContent(/^🤖Code$/)
  })

  it('has font size, fullscreen and connection controls outside the menu', () => {
    const props = renderHeader()
    expect(screen.getByTestId('font-size')).toHaveTextContent('14')
    fireEvent.click(screen.getByRole('button', { name: 'Decrease font size' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase font size' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }))
    expect(props.onDecreaseFont).toHaveBeenCalledOnce()
    expect(props.onIncreaseFont).toHaveBeenCalledOnce()
    expect(props.onToggleFullscreen).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Connected' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open sessions menu' }),
    ).toBeNull()
  })

  it('labels the fullscreen button by state', () => {
    renderHeader({ isFullscreen: true })
    expect(
      screen.getByRole('button', { name: 'Exit fullscreen' }),
    ).toBeVisible()
  })

  it('has no fullscreen button without onToggleFullscreen', () => {
    renderHeader({ onToggleFullscreen: undefined })
    expect(
      screen.queryByRole('button', { name: 'Enter fullscreen' }),
    ).toBeNull()
    expect(screen.queryByRole('button', { name: 'Exit fullscreen' })).toBeNull()
  })

  it('keeps the touch-size view and font buttons level with the tabs', () => {
    renderHeader({ views: TWO_VIEWS })
    for (const name of ['Chat', 'Decrease font size', 'Increase font size']) {
      const button =
        screen.queryByRole('tab', { name }) ??
        screen.getByRole('button', { name })
      expect(button).toHaveClass('pointer-coarse:h-9')
      expect(button).not.toHaveClass('pointer-coarse:h-touch')
    }
  })

  it('shows the view switcher with labels once there are two views', () => {
    const props = renderHeader({ views: TWO_VIEWS })
    const chat = screen.getByRole('tab', { name: 'Chat' })
    expect(chat).toHaveTextContent('Chat')
    expect(chat).toHaveAttribute('aria-controls', 'panel-chat')
    fireEvent.click(chat)
    expect(props.onViewChange).toHaveBeenCalledWith('chat')
  })

  it('hides the font size outside the terminal view', () => {
    renderHeader({ showFontSize: false })
    expect(screen.queryByTestId('font-size')).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Decrease font size' }),
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Enter fullscreen' }),
    ).toBeInTheDocument()
  })

  it('keeps the font size out of the desktop menu', () => {
    renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('group', { name: /Font size/ })).toBeNull()
  })
})

describe('AppHeader — mobile', () => {
  it('shows the session chip and opens the sessions sheet', () => {
    const props = renderHeader({ isMobile: true, showBrand: true })
    const chip = screen.getByRole('button', { name: 'Open sessions menu' })
    expect(chip).toHaveTextContent('main · 2 sessions')
    fireEvent.click(chip)
    expect(props.onOpenSessions).toHaveBeenCalledOnce()
    expect(screen.queryByRole('tablist', { name: 'Sessions' })).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Enter fullscreen' }),
    ).toBeNull()
    expect(screen.queryByTestId('brand-mark')).toBeNull()
  })

  it('moves the font size into the overflow menu', () => {
    const props = renderHeader({ isMobile: true })
    expect(
      screen.queryByRole('button', { name: 'Decrease font size' }),
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.getByRole('group', { name: 'Font size · 14' })).toBeVisible()
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Increase font size' }),
    )
    expect(props.onIncreaseFont).toHaveBeenCalledOnce()
  })

  it('drops the font size from the menu outside the terminal view', () => {
    renderHeader({ isMobile: true, showFontSize: false })
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('group', { name: /Font size/ })).toBeNull()
    expect(screen.getByRole('group', { name: 'Theme' })).toBeVisible()
  })

  it.each(['connecting', 'connected'] as const)(
    'has no retry button while %s',
    (connectionState) => {
      renderHeader({ isMobile: true, connectionState })
      expect(screen.queryByRole('button', { name: /Connect/ })).toBeNull()
    },
  )

  it.each([
    ['disconnected', 'Disconnected'],
    ['error', 'Connection error'],
  ] as const)('offers a retry once %s', (connectionState, name) => {
    const props = renderHeader({ isMobile: true, connectionState })
    fireEvent.click(screen.getByRole('button', { name }))
    expect(props.onRetry).toHaveBeenCalledOnce()
  })

  it('switches view from one button instead of tabs', () => {
    const props = renderHeader({ isMobile: true, views: TWO_VIEWS })
    expect(screen.queryByRole('tablist', { name: 'View' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View: Terminal' }))
    expect(
      screen.getByRole('menuitemradio', { name: 'Terminal' }),
    ).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Chat' }))
    expect(props.onViewChange).toHaveBeenCalledWith('chat')
  })

  it('shows no view button with a single view', () => {
    renderHeader({ isMobile: true })
    expect(screen.queryByRole('button', { name: /^View:/ })).toBeNull()
  })

  it('passes blockedElsewhere to the chip and shows in aria-label', () => {
    renderHeader({ isMobile: true, blockedElsewhere: 2 })
    const chip = screen.getByRole('button', {
      name: /Open sessions menu.*2 other sessions need you/,
    })
    expect(chip).toBeInTheDocument()
  })

  it('shows blockedElsewhere badge on the chip', () => {
    renderHeader({ isMobile: true, blockedElsewhere: 1 })
    const badge = screen.getByTestId('blocked-elsewhere')
    expect(badge).toHaveTextContent('1')
  })

  it('hides badge when blockedElsewhere is 0', () => {
    renderHeader({ isMobile: true, blockedElsewhere: 0 })
    expect(screen.queryByTestId('blocked-elsewhere')).not.toBeInTheDocument()
  })
})

describe('AppHeader side panel toggles', () => {
  const PANELS = [{ id: 'files', label: 'Files', Icon: SquareTerminal }]

  it('desktop: a pressed toggle closes its panel, another opens it', () => {
    const onTogglePanel = vi.fn()
    renderHeader({ panelViews: PANELS, sidePanelId: 'files', onTogglePanel })
    const toggle = screen.getByRole('button', { name: 'Files' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle)
    expect(onTogglePanel).toHaveBeenCalledWith(null)
  })

  it('desktop: an unpressed toggle opens its panel', () => {
    const onTogglePanel = vi.fn()
    renderHeader({ panelViews: PANELS, onTogglePanel })
    const toggle = screen.getByRole('button', { name: 'Files' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(onTogglePanel).toHaveBeenCalledWith('files')
  })

  it('shows no toggle group without panel views', () => {
    renderHeader({ onTogglePanel: vi.fn() })
    expect(screen.queryByRole('group', { name: 'Side panel' })).toBeNull()
  })

  it('mobile has no toggles', () => {
    renderHeader({ isMobile: true, panelViews: PANELS, onTogglePanel: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull()
  })
})

describe('AppHeader — command palette', () => {
  it('opens it from a desktop button that names its key', () => {
    const onOpenPalette = vi.fn()
    renderHeader({ onOpenPalette, paletteKey: 'Ctrl+Shift+P' })
    const button = screen.getByRole('button', { name: 'Command palette' })
    expect(button).toHaveAttribute('title', 'Command palette (Ctrl+Shift+P)')
    fireEvent.click(button)
    expect(onOpenPalette).toHaveBeenCalledOnce()
  })

  it('names no key when it has none, and has no button without a handler', () => {
    renderHeader({ onOpenPalette: vi.fn() })
    expect(
      screen.getByRole('button', { name: 'Command palette' }),
    ).toHaveAttribute('title', 'Command palette')
  })

  it('is not on the phone header', () => {
    renderHeader({ isMobile: true, onOpenPalette: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Command palette' })).toBeNull()
  })
})

describe('AppHeader — focus window', () => {
  it.each([false, true])(
    'names the session and hands back to the main window (mobile: %s)',
    (isMobile) => {
      const onOpenInMain = vi.fn()
      const props = renderHeader({
        isMobile,
        showSessionTabs: false,
        onOpenInMain,
      })
      expect(screen.getByText('Shell')).toBeInTheDocument()
      // No way to switch to another session from here
      expect(screen.queryByRole('tab', { name: /Code/ })).toBeNull()
      fireEvent.click(
        screen.getByRole('button', { name: 'Open in main window' }),
      )
      expect(onOpenInMain).toHaveBeenCalled()
      expect(props.onOpenSessions).not.toHaveBeenCalled()
    },
  )

  it('has no such button in the main window', () => {
    renderHeader({ isMobile: true })
    expect(
      screen.queryByRole('button', { name: 'Open in main window' }),
    ).toBeNull()
  })
})
