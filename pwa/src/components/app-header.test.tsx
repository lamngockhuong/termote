import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MessageSquare, SquareTerminal } from 'lucide-react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
        el.classList.contains('group')
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

  it('has font size and connection controls outside the menu', () => {
    const props = renderHeader()
    expect(screen.getByTestId('font-size')).toHaveTextContent('14')
    fireEvent.click(screen.getByRole('button', { name: 'Decrease font size' }))
    fireEvent.click(screen.getByRole('button', { name: 'Increase font size' }))
    expect(props.onDecreaseFont).toHaveBeenCalledOnce()
    expect(props.onIncreaseFont).toHaveBeenCalledOnce()
    expect(
      screen.queryByRole('button', { name: 'Enter fullscreen' }),
    ).toBeNull()
    expect(screen.getByRole('button', { name: 'Connected' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open sessions menu' }),
    ).toBeNull()
  })

  it('offers fullscreen in the menu, named by state, with its key', () => {
    const props = renderHeader({ fullscreenKey: 'F11' })
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    const item = screen.getByRole('menuitem', { name: /Enter fullscreen/ })
    expect(item).toHaveTextContent('F11')
    fireEvent.click(item)
    expect(props.onToggleFullscreen).toHaveBeenCalledOnce()
  })

  it('names the fullscreen item Exit once fullscreen', () => {
    renderHeader({ isFullscreen: true })
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(
      screen.getByRole('menuitem', { name: 'Exit fullscreen' }),
    ).toBeInTheDocument()
  })

  it('has no fullscreen item without onToggleFullscreen', () => {
    renderHeader({ onToggleFullscreen: undefined })
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('menuitem', { name: /fullscreen/ })).toBeNull()
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
  })

  it('keeps the font size out of the desktop menu', () => {
    renderHeader()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('group', { name: /Font size/ })).toBeNull()
  })
})

describe('AppHeader — FatherTabs', () => {
  const TABS: Session[] = [
    { id: '1', name: 'review/PR 1', icon: '', description: '', groupId: 'g' },
    { id: '2', name: 'Shell', icon: '', description: '', groupId: 'g' },
    { id: '3', name: 'review/PR 2', icon: '', description: '', groupId: 'g' },
    { id: '4', name: 'coding/api', icon: '', description: '', groupId: 'g' },
  ]
  const header = (p: Props) => (
    <ThemeProvider>
      <AppHeader {...p} />
    </ThemeProvider>
  )
  const tabNames = () =>
    [
      ...screen
        .getByRole('tablist', { name: 'Sessions' })
        .querySelectorAll('[role="tab"]'),
    ].map((t) => t.textContent)

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('has no FatherTabs row while no tab is in one', () => {
    renderHeader()
    expect(screen.queryByRole('tablist', { name: 'FatherTabs' })).toBeNull()
    expect(tabNames()).toEqual(['💻Shell', '🤖Code'])
  })

  it('shows the tabs of the FatherTab on screen, without its name', () => {
    renderHeader({ session: TABS[0], groupSessions: TABS })
    expect(screen.getByRole('tablist', { name: 'FatherTabs' })).toBeVisible()
    expect(tabNames().map((n) => n?.replace(/^\D*?(?=PR)/, ''))).toEqual([
      'PR 1',
      'PR 2',
    ])
    expect(screen.getByRole('tab', { name: /PR 1/ })).not.toHaveTextContent(
      'review',
    )
  })

  it('shows the tabs in no FatherTab under Other', () => {
    renderHeader({ session: TABS[1], groupSessions: TABS })
    expect(screen.getByRole('tab', { name: /Other/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(tabNames()).toHaveLength(1)
  })

  it('has no FatherTabs row where the tabs are not shown', () => {
    renderHeader({
      session: TABS[0],
      groupSessions: TABS,
      showSessionTabs: false,
    })
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('opens a FatherTab on its first tab, then on the one last shown in it', () => {
    const props = headerProps({ session: TABS[0], groupSessions: TABS })
    const { rerender } = render(header(props))
    fireEvent.click(screen.getByRole('tab', { name: /coding/ }))
    expect(props.onSelectTab).toHaveBeenLastCalledWith('4')
    // PR 2 shown, then coding: review opens on PR 2 again
    rerender(header({ ...props, session: TABS[2] }))
    rerender(header({ ...props, session: TABS[3] }))
    fireEvent.click(screen.getByRole('tab', { name: /review/ }))
    expect(props.onSelectTab).toHaveBeenLastCalledWith('3')
  })

  it("moves a tab to its place among all of the workspace's tabs", () => {
    const onMoveTab = vi.fn()
    renderHeader({ session: TABS[0], groupSessions: TABS, onMoveTab })
    const tab = screen.getByRole('tab', { name: /PR 1/ })
    tab.focus()
    fireEvent.keyDown(tab, { key: 'ArrowRight', altKey: true })
    // After PR 2, the third of the workspace's tabs
    expect(onMoveTab).toHaveBeenCalledWith('1', 2)
  })

  describe('a tab dropped on a FatherTab', () => {
    let under: Element | null = null
    beforeEach(() => {
      under = null
      document.elementFromPoint = () => under
    })
    afterEach(async () => {
      // @ts-expect-error jsdom has none of its own
      delete document.elementFromPoint
      // A drag's swallowed click is let go after its task
      await new Promise((r) => setTimeout(r))
    })
    const dropOn = (tab: RegExp, father: RegExp) => {
      const box = screen.getByRole('tab', { name: tab }).parentElement!
      fireEvent.pointerDown(box, {
        button: 0,
        pointerType: 'mouse',
        clientX: 10,
      })
      under = screen.getByRole('tab', { name: father })
      fireEvent.pointerMove(window, { clientX: 30 })
      fireEvent.pointerUp(window)
    }

    it('is renamed into it, or out of any on Other', () => {
      const onUpdateTab = vi.fn()
      renderHeader({ session: TABS[0], groupSessions: TABS, onUpdateTab })
      dropOn(/PR 1/, /coding/)
      expect(onUpdateTab).toHaveBeenLastCalledWith('1', { name: 'coding/PR 1' })
      dropOn(/PR 2/, /Other/)
      expect(onUpdateTab).toHaveBeenLastCalledWith('3', { name: 'PR 2' })
    })

    it('keeps its name on its own FatherTab', () => {
      const onUpdateTab = vi.fn()
      renderHeader({ session: TABS[0], groupSessions: TABS, onUpdateTab })
      dropOn(/PR 1/, /review/)
      expect(onUpdateTab).not.toHaveBeenCalled()
    })

    it('is not offered where tabs cannot be renamed', () => {
      const { unmount } = render(
        header(headerProps({ session: TABS[0], groupSessions: TABS })),
      )
      expect(
        screen.getByRole('tab', { name: /PR 1/ }).parentElement,
      ).not.toHaveAttribute('data-movable')
      unmount()
      renderHeader({
        session: TABS[0],
        groupSessions: TABS,
        onUpdateTab: vi.fn(),
        renameTab: false,
      })
      expect(
        screen.getByRole('tab', { name: /PR 1/ }).parentElement,
      ).not.toHaveAttribute('data-movable')
    })
  })

  it('asks a new tab its FatherTab, starting with the one on screen', () => {
    const props = renderHeader({
      session: TABS[0],
      groupSessions: TABS,
      addTabAsksName: true,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add session' }))
    const form = screen.getByRole('form', { name: 'New session' })
    const name = within(form).getByRole('textbox', { name: 'Session name' })
    expect(name).toHaveFocus()
    const father = within(form).getByRole('combobox', {
      name: 'FatherTab (optional)',
    })
    expect(father).toHaveValue('review')
    fireEvent.change(name, { target: { value: 'PR 3' } })
    fireEvent.submit(form)
    expect(props.onAddTab).toHaveBeenLastCalledWith('review/PR 3', undefined)
    // Cleared: a tab in no FatherTab
    fireEvent.click(screen.getByRole('button', { name: 'Add session' }))
    const again = screen.getByRole('form', { name: 'New session' })
    fireEvent.change(within(again).getByRole('combobox'), {
      target: { value: '' },
    })
    fireEvent.change(within(again).getByRole('textbox'), {
      target: { value: 'notes' },
    })
    fireEvent.submit(again)
    expect(props.onAddTab).toHaveBeenLastCalledWith('notes', undefined)
  })

  describe("a tab's menu", () => {
    const openMenu = (onUpdateTab = vi.fn(), over: Partial<Props> = {}) => {
      renderHeader({
        session: TABS[0],
        groupSessions: TABS,
        onUpdateTab,
        ...over,
      })
      fireEvent.contextMenu(screen.getByRole('tab', { name: /PR 1/ }))
      return onUpdateTab
    }
    const group = () => screen.getByRole('group', { name: 'Move to FatherTab' })

    it('moves the tab to another FatherTab, not offering its own', () => {
      const onUpdateTab = openMenu()
      expect(
        within(group())
          .getAllByRole('menuitem')
          .map((i) => i.textContent),
      ).toEqual(['coding', 'No FatherTab', 'New FatherTab…'])
      fireEvent.click(screen.getByRole('menuitem', { name: 'coding' }))
      expect(onUpdateTab).toHaveBeenCalledWith('1', { name: 'coding/PR 1' })
    })

    it('moves the tab out of any FatherTab', () => {
      const onUpdateTab = openMenu()
      fireEvent.click(screen.getByRole('menuitem', { name: 'No FatherTab' }))
      expect(onUpdateTab).toHaveBeenCalledWith('1', { name: 'PR 1' })
    })

    it('offers a tab in none every FatherTab, and no way out', () => {
      renderHeader({
        session: TABS[1],
        groupSessions: TABS,
        onUpdateTab: vi.fn(),
      })
      fireEvent.contextMenu(screen.getByRole('tab', { name: /Shell/ }))
      expect(
        within(group())
          .getAllByRole('menuitem')
          .map((i) => i.textContent),
      ).toEqual(['review', 'coding', 'New FatherTab…'])
    })

    it('names a new FatherTab on the tab: Enter moves it, an empty name and Escape do not', () => {
      const onUpdateTab = openMenu()
      const ask = () => {
        fireEvent.click(
          screen.getByRole('menuitem', { name: 'New FatherTab…' }),
        )
        return screen.getByRole('textbox', {
          name: 'New FatherTab for review/PR 1',
        })
      }
      let field = ask()
      expect(field).toHaveValue('')
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(onUpdateTab).not.toHaveBeenCalled()
      fireEvent.contextMenu(screen.getByRole('tab', { name: /PR 1/ }))
      field = ask()
      fireEvent.change(field, { target: { value: 'specs' } })
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(onUpdateTab).not.toHaveBeenCalled()
      fireEvent.contextMenu(screen.getByRole('tab', { name: /PR 1/ }))
      field = ask()
      fireEvent.change(field, { target: { value: ' specs ' } })
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(onUpdateTab).toHaveBeenCalledWith('1', { name: 'specs/PR 1' })
      // A rename after it asks for the name again
      fireEvent.keyDown(screen.getByRole('tab', { name: /PR 1/ }), {
        key: 'F2',
      })
      expect(
        screen.getByRole('textbox', { name: 'New name for review/PR 1' }),
      ).toHaveValue('review/PR 1')
    })

    it('has no FatherTab items where tabs cannot be renamed', () => {
      openMenu(vi.fn(), { renameTab: false })
      expect(screen.queryByRole('group')).toBeNull()
    })
  })

  it('adds a new FatherTab from the row', () => {
    const props = renderHeader({ session: TABS[0], groupSessions: TABS })
    fireEvent.click(screen.getByRole('button', { name: 'New FatherTab' }))
    const form = screen.getByRole('form', { name: 'New session' })
    fireEvent.change(within(form).getByRole('combobox'), {
      target: { value: 'specs' },
    })
    fireEvent.change(within(form).getByRole('textbox'), {
      target: { value: 'auth' },
    })
    fireEvent.submit(form)
    expect(props.onAddTab).toHaveBeenLastCalledWith('specs/auth', undefined)
  })

  it('shows the tabs given when the session is not among them', () => {
    const away: Session = {
      id: '9',
      name: 'specs/auth',
      icon: '',
      description: '',
      groupId: 'g2',
    }
    renderHeader({ session: away, groupSessions: TABS })
    expect(tabNames()).toHaveLength(4)
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
  it('opens it from the desktop menu, which names its key', () => {
    const onOpenPalette = vi.fn()
    renderHeader({ onOpenPalette, paletteKey: 'Ctrl+Shift+P' })
    expect(screen.queryByRole('button', { name: 'Command palette' })).toBeNull()
    const more = screen.getByRole('button', { name: 'More' })
    // The tour's palette step points at the menu
    expect(more.parentElement).toHaveAttribute('data-tour', 'palette')
    fireEvent.click(more)
    const item = screen.getByRole('menuitem', { name: /Command palette/ })
    expect(item).toHaveTextContent('Ctrl+Shift+P')
    fireEvent.click(item)
    expect(onOpenPalette).toHaveBeenCalledOnce()
  })

  it('names no key when it has none, and has no item without a handler', () => {
    const { unmount } = render(
      <ThemeProvider>
        <AppHeader {...headerProps({ onOpenPalette: vi.fn() })} />
      </ThemeProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(
      screen.getByRole('menuitem', { name: 'Command palette' }),
    ).toHaveTextContent(/^Command palette$/)
    unmount()
    renderHeader()
    const more = screen.getByRole('button', { name: 'More' })
    expect(more.parentElement).not.toHaveAttribute('data-tour')
    fireEvent.click(more)
    expect(screen.queryByRole('menuitem', { name: /palette/ })).toBeNull()
  })

  it('is not on the phone header nor in its menu', () => {
    renderHeader({ isMobile: true, onOpenPalette: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Command palette' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More' }))
    expect(screen.queryByRole('menuitem', { name: /palette/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /fullscreen/ })).toBeNull()
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

describe('AppHeader — labels give way to the tabs', () => {
  let resize: () => void = () => {}
  class FakeResizeObserver {
    constructor(cb: () => void) {
      resize = () => act(cb)
    }
    observe() {}
    disconnect() {}
  }
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  })
  afterEach(() => vi.unstubAllGlobals())

  const overflow = (by: number) => {
    const list = screen.getByRole('tablist', { name: 'Sessions' })
    Object.defineProperty(list, 'scrollWidth', {
      value: 400 + by,
      configurable: true,
    })
    Object.defineProperty(list, 'clientWidth', {
      value: 400,
      configurable: true,
    })
    resize()
  }

  it('drops the view and panel labels while the tabs overflow', () => {
    renderHeader({
      views: TWO_VIEWS,
      panelViews: [{ id: 'files', label: 'Files', Icon: SquareTerminal }],
      onTogglePanel: vi.fn(),
    })
    const labels = ['Terminal', 'Files'].map((n) => screen.getByText(n))
    for (const l of labels) expect(l).toHaveClass('@[60rem]:not-sr-only')
    overflow(50)
    for (const l of labels) expect(l).not.toHaveClass('@[60rem]:not-sr-only')
    // jsdom measures the labels as 0 px: back once 24 px are spare
    overflow(-23)
    expect(labels[0]).not.toHaveClass('@[60rem]:not-sr-only')
    overflow(-24)
    for (const l of labels) expect(l).toHaveClass('@[60rem]:not-sr-only')
  })

  it('keeps the labels when the tabs are not in the header', () => {
    const { rerender } = render(
      <ThemeProvider>
        <AppHeader {...headerProps({ views: TWO_VIEWS })} />
      </ThemeProvider>,
    )
    overflow(50)
    expect(screen.getByText('Chat')).not.toHaveClass('@[60rem]:not-sr-only')
    rerender(
      <ThemeProvider>
        <AppHeader
          {...headerProps({ views: TWO_VIEWS, showSessionTabs: false })}
        />
      </ThemeProvider>,
    )
    expect(screen.getByText('Chat')).toHaveClass('@[60rem]:not-sr-only')
  })
})

describe('AppHeader — toolbar on the right bar', () => {
  it('keeps the tabs, chips, font size, connection and menu only', () => {
    renderHeader({
      toolbar: 'right',
      views: TWO_VIEWS,
      panelViews: [{ id: 'files', label: 'Files', Icon: SquareTerminal }],
      onTogglePanel: vi.fn(),
      paneMenu: <button type="button">Pane</button>,
      onOpenPalette: vi.fn(),
      hostChip: <span>cpu 3%</span>,
    })
    expect(screen.getByRole('tablist', { name: 'Sessions' })).toBeVisible()
    expect(screen.getByText('cpu 3%')).toBeInTheDocument()
    expect(screen.getByTestId('font-size')).toBeInTheDocument()
    expect(screen.queryByRole('tablist', { name: 'View' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Files' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pane' })).toBeNull()
    const more = screen.getByRole('button', { name: 'More' })
    // The bar's own palette button is the tour's anchor
    expect(more.parentElement).not.toHaveAttribute('data-tour')
    fireEvent.click(more)
    expect(screen.queryByRole('menuitem', { name: /palette/ })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: /fullscreen/ })).toBeNull()
  })

  it('keeps the phone header as it is', () => {
    renderHeader({
      isMobile: true,
      toolbar: 'right',
      views: TWO_VIEWS,
      paneMenu: <button type="button">Pane</button>,
    })
    expect(screen.getByRole('button', { name: 'Pane' })).toBeInTheDocument()
  })
})
