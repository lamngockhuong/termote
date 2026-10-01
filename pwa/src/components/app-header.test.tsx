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
  const props: Props = {
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
  render(
    <ThemeProvider>
      <AppHeader {...props} />
    </ThemeProvider>,
  )
  return props
}

const TWO_VIEWS = [
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
]

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

  it('names the session only, with its description, when tabs are off', () => {
    renderHeader({ showSessionTabs: false })
    expect(screen.queryByRole('tablist', { name: 'Sessions' })).toBeNull()
    expect(screen.getByTitle('Shell - Terminal')).toHaveTextContent(
      '💻ShellTerminal',
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

  it('shows the view switcher with labels once there are two views', () => {
    const props = renderHeader({ views: TWO_VIEWS })
    const chat = screen.getByRole('tab', { name: 'Chat' })
    expect(chat).toHaveTextContent('Chat')
    expect(chat).toHaveAttribute('aria-controls', 'panel-chat')
    fireEvent.click(chat)
    expect(props.onViewChange).toHaveBeenCalledWith('chat')
  })

  it('keeps the font size out of the desktop menu', () => {
    renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('group', { name: /Font size/ })).toBeNull()
  })
})

describe('AppHeader — mobile', () => {
  it('shows the session chip and opens the sessions sheet', () => {
    const props = renderHeader({ isMobile: true })
    const chip = screen.getByRole('button', { name: 'Open sessions menu' })
    expect(chip).toHaveTextContent('main · 2 sessions')
    fireEvent.click(chip)
    expect(props.onOpenSessions).toHaveBeenCalledOnce()
    expect(screen.queryByRole('tablist', { name: 'Sessions' })).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Enter fullscreen' }),
    ).toBeNull()
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

  it('shows the view switcher as icons', () => {
    renderHeader({ isMobile: true, views: TWO_VIEWS })
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveTextContent('')
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
