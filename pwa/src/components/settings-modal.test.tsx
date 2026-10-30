import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import { viewerClosing } from '../hooks/use-history-close'
import { FIND_EXCLUDES_DEFAULT, type Settings } from '../hooks/use-settings'
import { SettingsModal } from './settings-modal'

const notify = vi.hoisted(() => ({
  needsHomeScreenApp: vi.fn(() => false),
  notificationSupport: vi.fn(() => 'unsupported'),
  notifyWorkerReady: vi.fn(() => Promise.resolve(true)),
  requestNotify: vi.fn(() => Promise.resolve('granted')),
}))
vi.mock('../utils/notify-permission', () => notify)

// The Updates group's own behaviour is tested in updates-section.test.tsx.
vi.mock('./updates-section', () => ({
  UpdatesSection: (p: {
    server: { version: string } | null
    stale: boolean
    onReload: () => void
  }) => (
    <div data-testid="updates-section">
      {p.server?.version} {p.stale ? 'stale' : ''}
      <button type="button" onClick={p.onReload}>
        Reload
      </button>
    </div>
  ),
}))

// The Devices group's own behaviour is tested in devices-section.test.tsx.
vi.mock('./devices-section', () => ({
  DevicesSection: () => <div data-testid="devices-section" />,
}))
// And Prompt templates' in prompt-templates-section.test.tsx.
vi.mock('./prompt-templates-section', () => ({
  PromptTemplatesSection: ({ readOnly }: { readOnly?: boolean }) => (
    <div data-testid="templates-section" data-read-only={String(readOnly)} />
  ),
}))
// And the Tasks group's in user-tasks-section.test.tsx.
vi.mock('./user-tasks-section', () => ({
  UserTasksSection: () => <div data-testid="user-tasks-section" />,
}))
// And the Signed-in browsers group's in signins-section.test.tsx.
vi.mock('./signins-section', () => ({
  SigninsSection: ({ logOut }: { logOut?: () => void }) => (
    <button type="button" data-testid="signins-section" onClick={logOut}>
      SignOutThisBrowser
    </button>
  ),
}))

const DEFAULT_SETTINGS: Settings = {
  herdrLayoutView: true,
  markdownEditLayout: 'split',
  imeSendBehavior: 'send-only',
  pasteSource: 'clipboard',
  toolbarDefaultExpanded: false,
  disableContextMenu: true,
  copyOnSelect: false,
  showSessionTabs: false,
  pollInterval: 5,
  welcomeSeenVersion: 0,
  language: 'auto',
  languageNoticeSeen: false,
  hasSeenLocalhostNotice: false,
  terminalFont: '',
  uiStyle: 'neutral',
  driveTerminalSize: false,
  sidebarFilter: 'all',
  sortBlockedFirst: false,
  markdownPreview: true,
  tablePreview: true,
  svgPreview: false,
  sidePanelWidth: 440,
  findIncludeIgnored: false,
  findExcludes: FIND_EXCLUDES_DEFAULT,
  searchCase: false,
  searchWord: false,
  searchRegex: false,
  notifyAgents: false,
  stuckMinutes: 10,
  showUsageChip: true,
  editorFontSize: 13,
  editorTabSize: 4,
  editorWrap: false,
  editorVim: false,
  taskHistoryLines: 400,
}

describe('SettingsModal', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi
      .fn()
      .mockImplementation(function (this: HTMLDialogElement) {
        this.removeAttribute('hidden')
        this.style.display = 'block'
      })
    HTMLDialogElement.prototype.close = vi.fn().mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.style.display = 'none'
    })
  })

  function renderModal(
    overrides: Partial<Parameters<typeof SettingsModal>[0]> = {},
  ) {
    const onClose = vi.fn()
    const onUpdateSetting = vi.fn()
    const props = {
      isOpen: true,
      onClose,
      settings: DEFAULT_SETTINGS,
      onUpdateSetting,
      ...overrides,
    }
    const result = render(<SettingsModal {...props} />, {
      wrapper: ThemeProvider,
    })
    return { ...result, onClose, onUpdateSetting }
  }

  it('renders nothing when isOpen is false', () => {
    const { container } = renderModal({ isOpen: false })
    expect(container.querySelector('dialog')).toBeNull()
  })

  it('renders settings dialog when isOpen is true', () => {
    renderModal()
    const dialog = document.querySelector('dialog')
    expect(dialog).toBeInTheDocument()
  })

  it('keeps the full-screen phone sheet below the status bar', () => {
    const { container } = renderModal()
    expect(container.querySelector('dialog')).toHaveClass(
      'max-md:h-(--app-height)',
      'max-md:pt-[env(safe-area-inset-top)]',
    )
  })

  it('calls showModal on open', () => {
    renderModal()
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled()
  })

  it('removes dialog from DOM when isOpen becomes false', () => {
    const { rerender, onClose } = renderModal()
    expect(document.querySelector('dialog')).toBeInTheDocument()
    rerender(
      <SettingsModal
        isOpen={false}
        onClose={onClose}
        settings={DEFAULT_SETTINGS}
        onUpdateSetting={vi.fn()}
      />,
    )
    // When isOpen=false the component returns null, removing the dialog
    expect(document.querySelector('dialog')).not.toBeInTheDocument()
  })

  it('calls onClose when close button clicked', () => {
    const { onClose } = renderModal()
    const closeBtn = document.querySelector(
      'button[aria-label="Close"]',
    ) as HTMLElement
    expect(closeBtn).toBeTruthy()
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when dialog backdrop clicked (target === currentTarget)', () => {
    const { onClose } = renderModal()
    const dialog = document.querySelector('dialog')!
    // A press that starts and ends on the scrim closes the sheet
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    expect(onClose).toHaveBeenCalled()
  })

  it('does not call onClose when clicking inside dialog content', () => {
    const { onClose } = renderModal()
    const dialog = document.querySelector('dialog')!
    const inner = dialog.querySelector('h2')!
    fireEvent.click(inner)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose when cancel event fires on dialog', () => {
    const { onClose } = renderModal()
    const dialog = document.querySelector('dialog')!
    const event = new Event('cancel', { cancelable: true, bubbles: true })
    dialog.dispatchEvent(event)
    expect(onClose).toHaveBeenCalled()
  })

  it('prevents default on cancel event', () => {
    renderModal()
    const dialog = document.querySelector('dialog')!
    const event = new Event('cancel', { cancelable: true, bubbles: true })
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
    dialog.dispatchEvent(event)
    expect(preventDefaultSpy).toHaveBeenCalled()
  })

  it('removes cancel event listener when isOpen changes', () => {
    const { onClose, rerender } = renderModal()
    const dialog = document.querySelector('dialog')!
    rerender(
      <SettingsModal
        isOpen={false}
        onClose={onClose}
        settings={DEFAULT_SETTINGS}
        onUpdateSetting={vi.fn()}
      />,
    )
    const prevCalls = onClose.mock.calls.length
    const event = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(event)
    expect(onClose.mock.calls.length).toBe(prevCalls)
  })

  it('updates imeSendBehavior when send-enter radio selected', () => {
    const { onUpdateSetting } = renderModal()
    fireEvent.click(screen.getByRole('radio', { name: 'Send + Enter' }))
    expect(onUpdateSetting).toHaveBeenCalledWith(
      'imeSendBehavior',
      'send-enter',
    )
  })

  it('updates imeSendBehavior when send-only radio selected', () => {
    const { onUpdateSetting } = renderModal({
      settings: { ...DEFAULT_SETTINGS, imeSendBehavior: 'send-enter' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Send text only' }))
    expect(onUpdateSetting).toHaveBeenCalledWith('imeSendBehavior', 'send-only')
  })

  it('shows the hint of the selected send behavior', () => {
    renderModal({
      settings: { ...DEFAULT_SETTINGS, imeSendBehavior: 'send-enter' },
    })
    expect(
      screen.getByText('Send text then press Enter automatically'),
    ).toBeInTheDocument()
  })

  it('updates pasteSource when the buffer radio selected', () => {
    const { onUpdateSetting } = renderModal()
    fireEvent.click(screen.getByRole('radio', { name: 'Session buffer' }))
    expect(onUpdateSetting).toHaveBeenCalledWith('pasteSource', 'tmux')
  })

  it('updates pasteSource when clipboard radio selected', () => {
    const { onUpdateSetting } = renderModal({
      settings: { ...DEFAULT_SETTINGS, pasteSource: 'tmux' },
    })
    fireEvent.click(screen.getByRole('radio', { name: 'System clipboard' }))
    expect(onUpdateSetting).toHaveBeenCalledWith('pasteSource', 'clipboard')
  })

  it('names the paste buffer after the pasteBufferLabel prop, not a backend', () => {
    renderModal({ pasteBufferLabel: 'zellij buffer' })
    expect(
      screen.getByRole('radio', { name: 'zellij buffer' }),
    ).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/tmux/i)
  })

  it('toggles toolbarDefaultExpanded', () => {
    const { onUpdateSetting } = renderModal()
    fireEvent.click(
      screen.getByRole('switch', { name: 'Toolbar default expanded' }),
    )
    expect(onUpdateSetting).toHaveBeenCalledWith('toolbarDefaultExpanded', true)
  })

  it('toggles disableContextMenu', () => {
    const { onUpdateSetting } = renderModal()
    fireEvent.click(
      screen.getByRole('switch', { name: 'Disable right-click menu' }),
    )
    expect(onUpdateSetting).toHaveBeenCalledWith('disableContextMenu', false)
  })

  it('toggles copyOnSelect', () => {
    const { onUpdateSetting } = renderModal()
    fireEvent.click(screen.getByRole('switch', { name: 'Copy on select' }))
    expect(onUpdateSetting).toHaveBeenCalledWith('copyOnSelect', true)
  })

  it('offers the herdr drive switch only when the backend supports it', () => {
    renderModal()
    expect(
      screen.queryByRole('switch', { name: 'Fit herdr pane to this device' }),
    ).toBeNull()
  })

  it('toggles driveTerminalSize', () => {
    const { onUpdateSetting } = renderModal({ driveSizeSupported: true })
    fireEvent.click(
      screen.getByRole('switch', { name: 'Fit herdr pane to this device' }),
    )
    expect(onUpdateSetting).toHaveBeenCalledWith('driveTerminalSize', true)
  })

  it('toggles herdrLayoutView where the panes can show side by side', () => {
    const { onUpdateSetting } = renderModal({ layoutViewSupported: true })
    fireEvent.click(
      screen.getByRole('switch', { name: 'Show herdr panes side by side' }),
    )
    expect(onUpdateSetting).toHaveBeenCalledWith('herdrLayoutView', false)
  })

  it('hides herdrLayoutView elsewhere', () => {
    renderModal()
    expect(
      screen.queryByRole('switch', { name: 'Show herdr panes side by side' }),
    ).toBeNull()
  })

  it('toggles showSessionTabs', () => {
    const { onUpdateSetting } = renderModal()
    fireEvent.click(screen.getByRole('switch', { name: 'Show session tabs' }))
    expect(onUpdateSetting).toHaveBeenCalledWith('showSessionTabs', true)
  })

  it('starts with the Appearance group and lists the three styles', () => {
    renderModal()
    const groups = document.querySelectorAll('[data-group]')
    expect(groups[0]).toHaveAttribute('data-group', 'appearance')
    const radios = screen
      .getByRole('radiogroup', { name: 'Interface style' })
      .querySelectorAll('[role="radio"]')
    expect(Array.from(radios).map((r) => r.getAttribute('aria-label'))).toEqual(
      ['Neutral', 'Terminal', 'Native'],
    )
    expect(
      screen.getByRole('radio', { name: 'Neutral', checked: true }),
    ).toBeInTheDocument()
    expect(document.querySelectorAll('[data-preview]').length).toBe(3)
  })

  it('writes uiStyle when a style is picked', () => {
    const { onUpdateSetting } = renderModal()
    fireEvent.click(screen.getByRole('radio', { name: 'Terminal' }))
    expect(onUpdateSetting).toHaveBeenCalledWith('uiStyle', 'terminal')
  })

  it('marks the stored style as selected', () => {
    renderModal({ settings: { ...DEFAULT_SETTINGS, uiStyle: 'native' } })
    expect(
      screen.getByRole('radio', { name: 'Native', checked: true }),
    ).toBeInTheDocument()
  })

  it('shows one group at a time on desktop, switched from the left rail', () => {
    renderModal()
    const section = (id: string) =>
      document.querySelector(`[data-group="${id}"]`)!
    // Every group is in the page; the CSS hides the inactive ones
    expect(section('appearance')).not.toHaveClass('hidden')
    expect(section('keyboard')).toHaveClass('hidden')
    const nav = screen.getByRole('navigation', { name: 'Settings groups' })
    const keyboard = within(nav).getByRole('button', { name: 'Keyboard' })
    fireEvent.click(keyboard)
    expect(section('keyboard')).not.toHaveClass('hidden')
    expect(section('appearance')).toHaveClass('hidden')
    expect(keyboard).toHaveAttribute('aria-current', 'true')
    // No way back on desktop: the rail stays
    expect(
      screen.queryByRole('button', { name: 'Back to Settings' }),
    ).toBeNull()
  })

  it('names each group for a screen reader only: the rail shows it', () => {
    renderModal()
    const appearance = screen.getByRole('region', { name: 'Appearance' })
    expect(within(appearance).getByRole('heading')).toHaveClass('sr-only')
  })

  it('grows a rail button with its label instead of a fixed height', () => {
    renderModal()
    const nav = screen.getByRole('navigation', { name: 'Settings groups' })
    const appearance = within(nav).getByRole('button', { name: 'Appearance' })
    expect(appearance).toHaveClass('min-h-9', 'font-semibold')
    expect(appearance).not.toHaveClass('h-9')
    expect(within(nav).getByRole('button', { name: 'Keyboard' })).toHaveClass(
      'text-fg-muted',
    )
  })

  it('picks the colour mode in Appearance, as the ⋯ menu does', () => {
    localStorage.setItem('termote-theme', 'light')
    renderModal()
    const modes = screen.getByRole('radiogroup', { name: 'Theme' })
    expect(
      within(modes).getByRole('radio', { name: 'Light', checked: true }),
    ).toBeInTheDocument()
    fireEvent.click(within(modes).getByRole('radio', { name: 'Dark' }))
    expect(
      within(modes).getByRole('radio', { name: 'Dark', checked: true }),
    ).toBeInTheDocument()
    expect(document.documentElement).toHaveClass('dark')
    expect(localStorage.getItem('termote-theme')).toBe('dark')
  })

  it('sets how files are edited on desktop', () => {
    const { onUpdateSetting } = renderModal()
    const group = document.querySelector('[data-group="files"]') as HTMLElement
    fireEvent.change(within(group).getByLabelText('Editor font size'), {
      target: { value: '16' },
    })
    expect(onUpdateSetting).toHaveBeenLastCalledWith('editorFontSize', 16)
    fireEvent.change(within(group).getByLabelText('Tab size'), {
      target: { value: '2' },
    })
    expect(onUpdateSetting).toHaveBeenLastCalledWith('editorTabSize', 2)
    fireEvent.click(within(group).getByRole('switch', { name: 'Wrap lines' }))
    expect(onUpdateSetting).toHaveBeenLastCalledWith('editorWrap', true)
    fireEvent.click(within(group).getByRole('switch', { name: 'Vim mode' }))
    expect(onUpdateSetting).toHaveBeenLastCalledWith('editorVim', true)
  })

  it('edits the folders a file search never enters', () => {
    const { onUpdateSetting, rerender } = renderModal({
      settings: { ...DEFAULT_SETTINGS, findExcludes: ['dist', 'vendor'] },
    })
    const group = document.querySelector('[data-group="files"]') as HTMLElement
    const list = within(group).getByRole('list', {
      name: 'Folders never searched',
    })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(within(group).getByRole('button', { name: 'Remove dist' }))
    expect(onUpdateSetting).toHaveBeenLastCalledWith('findExcludes', ['vendor'])
    const input = within(group).getByLabelText('Excluded folders')
    // Refused with the reason, under the box
    for (const [name, why] of [
      ['a/b', 'One folder name, not a path'],
      ['vendor', 'Already in the list'],
      ['  ', 'Enter a folder name'],
    ]) {
      fireEvent.change(input, { target: { value: name } })
      fireEvent.click(within(group).getByRole('button', { name: 'Add' }))
      expect(within(group).getByRole('alert')).toHaveTextContent(why)
      expect(input).toHaveAttribute('aria-invalid', 'true')
    }
    // Typing again clears it; Enter adds
    fireEvent.change(input, { target: { value: ' build ' } })
    expect(within(group).queryByRole('alert')).toBeNull()
    fireEvent.keyDown(input, { key: 'a' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onUpdateSetting).toHaveBeenLastCalledWith('findExcludes', [
      'dist',
      'vendor',
      'build',
    ])
    expect(input).toHaveValue('')
    // Back to the defaults; disabled once there
    fireEvent.click(
      within(group).getByRole('button', { name: 'Reset to defaults' }),
    )
    expect(onUpdateSetting).toHaveBeenLastCalledWith(
      'findExcludes',
      FIND_EXCLUDES_DEFAULT,
    )
    rerender(
      <SettingsModal
        isOpen
        onClose={vi.fn()}
        settings={DEFAULT_SETTINGS}
        onUpdateSetting={onUpdateSetting}
      />,
    )
    expect(
      within(group).getByRole('button', { name: 'Reset to defaults' }),
    ).toBeDisabled()
  })

  it('refuses a folder past the cap', () => {
    const full = Array.from({ length: 50 }, (_, i) => `d${i}`)
    renderModal({ settings: { ...DEFAULT_SETTINGS, findExcludes: full } })
    const group = document.querySelector('[data-group="files"]') as HTMLElement
    fireEvent.change(within(group).getByLabelText('Excluded folders'), {
      target: { value: 'more' },
    })
    fireEvent.click(within(group).getByRole('button', { name: 'Add' }))
    expect(within(group).getByRole('alert')).toHaveTextContent(
      'At most 50 folders',
    )
  })

  it('lists the Data group in the rail only when it has actions', () => {
    const { unmount } = renderModal()
    const nav = () =>
      screen.getByRole('navigation', { name: 'Settings groups' })
    expect(
      within(nav()).queryByRole('button', { name: 'Data & help' }),
    ).toBeNull()
    unmount()
    renderModal({ onShowWelcome: vi.fn() })
    expect(
      within(nav()).getByRole('button', { name: 'Data & help' }),
    ).toBeInTheDocument()
  })

  it('falls back to the first group when the open one goes away', () => {
    const { rerender, onClose } = renderModal({ onShowWelcome: vi.fn() })
    fireEvent.click(screen.getByRole('button', { name: 'Data & help' }))
    rerender(
      <SettingsModal
        isOpen
        onClose={onClose}
        settings={DEFAULT_SETTINGS}
        onUpdateSetting={vi.fn()}
      />,
    )
    expect(document.querySelector('[data-group="appearance"]')).not.toHaveClass(
      'md:hidden',
    )
  })

  it('saves the terminal font on blur, trimmed', () => {
    const { onUpdateSetting, getByLabelText } = renderModal()
    const input = getByLabelText('Terminal font') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  Fira Code  ' } })
    expect(onUpdateSetting).not.toHaveBeenCalled()
    fireEvent.blur(input)
    expect(onUpdateSetting).toHaveBeenCalledWith('terminalFont', 'Fira Code')
  })

  it('saves the terminal font on Enter, only when it changed', () => {
    const { onUpdateSetting, getByLabelText } = renderModal({
      settings: { ...DEFAULT_SETTINGS, terminalFont: 'Hack' },
    })
    const input = getByLabelText('Terminal font') as HTMLInputElement
    expect(input.value).toBe('Hack')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onUpdateSetting).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'a' })
    expect(onUpdateSetting).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onUpdateSetting).toHaveBeenCalledWith('terminalFont', '')
  })

  it('sets when a quiet working agent counts as stuck', () => {
    const { onUpdateSetting } = renderModal()
    expect(document.body.textContent).toContain('quiet for 10 min')
    fireEvent.change(screen.getByLabelText('Stuck agent after'), {
      target: { value: '30' },
    })
    expect(onUpdateSetting).toHaveBeenCalledWith('stuckMinutes', 30)
  })

  it('updates pollInterval via select', () => {
    const { onUpdateSetting } = renderModal()
    const select = screen.getByLabelText('Session poll interval')
    fireEvent.change(select, { target: { value: '30' } })
    expect(onUpdateSetting).toHaveBeenCalledWith('pollInterval', 30)
  })

  it('displays formatSeconds correctly for < 60s', () => {
    renderModal({ settings: { ...DEFAULT_SETTINGS, pollInterval: 5 } })
    expect(document.body.textContent).toContain('5s')
  })

  it('displays formatSeconds correctly for >= 60s (minutes)', () => {
    renderModal({ settings: { ...DEFAULT_SETTINGS, pollInterval: 60 } })
    expect(document.body.textContent).toContain('1m')
  })

  it('displays formatSeconds for 120s as 2m', () => {
    renderModal({ settings: { ...DEFAULT_SETTINGS, pollInterval: 120 } })
    expect(document.body.textContent).toContain('2m')
  })

  it('does not render optional buttons when handlers not provided', () => {
    renderModal()
    expect(document.body.textContent).not.toContain('Show welcome screen')
    expect(document.body.textContent).not.toContain('Check for Updates')
    expect(document.body.textContent).not.toContain('Clear Command History')
  })

  it('renders Show welcome screen button when handler provided', () => {
    const onShowWelcome = vi.fn()
    renderModal({ onShowWelcome })
    expect(document.body.textContent).toContain('Show welcome screen')
  })

  it('calls onShowWelcome when button clicked', () => {
    const onShowWelcome = vi.fn()
    renderModal({ onShowWelcome })
    const btns = document.querySelectorAll('button')
    const welcomeBtn = Array.from(btns).find((b) =>
      b.textContent?.includes('Show welcome screen'),
    )!
    fireEvent.click(welcomeBtn)
    expect(onShowWelcome).toHaveBeenCalled()
  })

  it('takes the tour from Data & help', () => {
    const onStartTour = vi.fn()
    renderModal({ onStartTour })
    fireEvent.click(screen.getByRole('button', { name: 'Data & help' }))
    fireEvent.click(screen.getByRole('button', { name: 'Take the tour' }))
    expect(onStartTour).toHaveBeenCalled()
  })

  it("picks the app's language", () => {
    const { onUpdateSetting } = renderModal()
    const group = screen.getByRole('radiogroup', { name: 'Language' })
    expect(within(group).getByRole('radio', { name: 'Auto' })).toBeChecked()
    fireEvent.click(within(group).getByRole('radio', { name: 'Tiếng Việt' }))
    expect(onUpdateSetting).toHaveBeenCalledWith('language', 'vi')
  })

  it('shows the Updates group only when given', () => {
    renderModal()
    expect(screen.queryByTestId('updates-section')).not.toBeInTheDocument()
    const onReload = vi.fn()
    renderModal({
      updates: {
        server: { version: '1.2.3', install: 'release' },
        stale: true,
        reloading: false,
        onReload,
      },
    })
    const section = screen.getByTestId('updates-section')
    expect(section).toHaveTextContent('1.2.3 stale')
    fireEvent.click(within(section).getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Updates' })).toBeInTheDocument()
  })

  it('opens at the group it is given, picked in the rail', () => {
    renderModal({
      initialGroup: 'updates',
      updates: {
        server: null,
        stale: false,
        reloading: false,
        onReload: vi.fn(),
      },
    })
    expect(screen.getByRole('button', { name: 'Updates' })).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('opens at Appearance without a group', () => {
    renderModal()
    expect(screen.getByRole('button', { name: 'Appearance' })).toHaveAttribute(
      'aria-current',
      'true',
    )
  })

  it('renders Clear Command History button when handler provided', () => {
    const onClearHistory = vi.fn()
    renderModal({ onClearHistory, historyCount: 5 })
    expect(document.body.textContent).toContain('Clear Command History (5)')
  })

  it('disables Clear Command History when historyCount is 0', () => {
    const onClearHistory = vi.fn()
    renderModal({ onClearHistory, historyCount: 0 })
    const btns = document.querySelectorAll('button')
    const clearBtn = Array.from(btns).find((b) =>
      b.textContent?.includes('Clear Command History'),
    )! as HTMLButtonElement
    expect(clearBtn.disabled).toBe(true)
  })

  it('calls onClearHistory when button clicked', () => {
    const onClearHistory = vi.fn()
    renderModal({ onClearHistory, historyCount: 3 })
    const btns = document.querySelectorAll('button')
    const clearBtn = Array.from(btns).find((b) =>
      b.textContent?.includes('Clear Command History'),
    )!
    fireEvent.click(clearBtn)
    expect(onClearHistory).toHaveBeenCalled()
  })

  it('historyCount defaults to 0', () => {
    const onClearHistory = vi.fn()
    renderModal({ onClearHistory })
    expect(document.body.textContent).toContain('Clear Command History (0)')
  })

  it('renders all optional action buttons in footer section', () => {
    const onShowWelcome = vi.fn()
    const onClearHistory = vi.fn()
    renderModal({
      onShowWelcome,
      onClearHistory,
      historyCount: 1,
    })
    expect(document.body.textContent).toContain('Show welcome screen')
    expect(document.body.textContent).toContain('Clear Command History')
  })

  it('switches report their checked state', () => {
    renderModal({
      settings: { ...DEFAULT_SETTINGS, toolbarDefaultExpanded: true },
    })
    expect(
      screen.getByRole('switch', { name: 'Toolbar default expanded' }),
    ).toBeChecked()
    expect(
      screen.getByRole('switch', { name: 'Show session tabs' }),
    ).not.toBeChecked()
  })

  it('Settings heading is present', () => {
    renderModal()
    expect(document.body.textContent).toContain('Settings')
  })

  it('poll interval select has correct options', () => {
    renderModal()
    const select = screen.getByLabelText(
      'Session poll interval',
    ) as HTMLSelectElement
    const options = Array.from(select.options).map((o) => o.value)
    expect(options).toContain('3')
    expect(options).toContain('60')
    expect(options).toContain('300')
  })

  it('IME send behavior and paste source groups have both options', () => {
    renderModal()
    const ime = screen.getByRole('radiogroup', {
      name: 'Text input send behavior',
    })
    expect(within(ime).getAllByRole('radio')).toHaveLength(2)
    const paste = screen.getByRole('radiogroup', {
      name: 'Paste button source',
    })
    expect(within(paste).getAllByRole('radio')).toHaveLength(2)
  })

  it('hides the paste source choice on a backend without a tmux buffer', () => {
    const { container } = renderModal({ tmuxBufferSupported: false })
    expect(container.ownerDocument.body).not.toHaveTextContent(
      'Paste button source',
    )
    expect(
      screen.queryByRole('radiogroup', { name: 'Paste button source' }),
    ).toBeNull()
  })

  it('toggles sortBlockedFirst', () => {
    const { onUpdateSetting } = renderModal()
    fireEvent.click(
      screen.getByRole('switch', { name: 'Blocked sessions first' }),
    )
    expect(onUpdateSetting).toHaveBeenCalledWith('sortBlockedFirst', true)
  })

  it('shows the description for sortBlockedFirst', () => {
    renderModal()
    expect(
      screen.getByText('List sessions waiting on you at the top of each group'),
    ).toBeInTheDocument()
  })

  it('toggles the usage chip, on by default', () => {
    const { onUpdateSetting } = renderModal()
    const sw = screen.getByRole('switch', { name: 'Agent usage in the header' })
    expect(sw).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(sw)
    expect(onUpdateSetting).toHaveBeenCalledWith('showUsageChip', false)
  })

  it('reflects stored sortBlockedFirst state', () => {
    renderModal({ settings: { ...DEFAULT_SETTINGS, sortBlockedFirst: true } })
    const switchElement = screen.getByRole('switch', {
      name: 'Blocked sessions first',
    })
    expect(switchElement).toHaveAttribute('aria-checked', 'true')
  })

  describe('Notify when an agent needs me', () => {
    const NAME = 'Notify when an agent needs me'
    beforeEach(() => {
      notify.needsHomeScreenApp.mockReturnValue(false)
      notify.notificationSupport.mockReturnValue('default')
      notify.notifyWorkerReady.mockResolvedValue(true)
      notify.requestNotify.mockResolvedValue('granted')
    })

    async function renderReady(settings: Partial<Settings> = {}) {
      const r = renderModal({ settings: { ...DEFAULT_SETTINGS, ...settings } })
      const sw = screen.getByRole('switch', { name: NAME })
      await waitFor(() => expect(notify.notifyWorkerReady).toHaveBeenCalled())
      await act(async () => {})
      return { ...r, sw }
    }

    it('is hidden where notifications are unsupported', () => {
      notify.notificationSupport.mockReturnValue('unsupported')
      renderModal()
      expect(screen.queryByRole('switch', { name: NAME })).toBeNull()
    })

    it('asks for the permission, then turns on', async () => {
      const { sw, onUpdateSetting } = await renderReady()
      await waitFor(() => expect(sw).not.toBeDisabled())
      await act(async () => fireEvent.click(sw))
      await waitFor(() =>
        expect(onUpdateSetting).toHaveBeenCalledWith('notifyAgents', true),
      )
      expect(notify.requestNotify).toHaveBeenCalled()
    })

    it('subscribes to push in the same click when the server sends it', async () => {
      const order: string[] = []
      const onEnableNotify = vi.fn(async () => {
        order.push('subscribe')
      })
      const onUpdateSetting = vi.fn(() => order.push('setting'))
      renderModal({ pushAvailable: true, onEnableNotify, onUpdateSetting })
      const sw = screen.getByRole('switch', { name: NAME })
      await waitFor(() => expect(sw).not.toBeDisabled())
      await act(async () => fireEvent.click(sw))
      await waitFor(() => expect(order).toEqual(['subscribe', 'setting']))
    })

    it('leaves push alone when the server does not send it', async () => {
      const onEnableNotify = vi.fn(async () => {})
      renderModal({ onEnableNotify })
      const sw = screen.getByRole('switch', { name: NAME })
      await waitFor(() => expect(sw).not.toBeDisabled())
      await act(async () => fireEvent.click(sw))
      expect(onEnableNotify).not.toHaveBeenCalled()
    })

    it('unsubscribes when turned off', async () => {
      notify.notificationSupport.mockReturnValue('granted')
      const onDisableNotify = vi.fn()
      renderModal({
        settings: { ...DEFAULT_SETTINGS, notifyAgents: true },
        onDisableNotify,
      })
      await act(async () =>
        fireEvent.click(screen.getByRole('switch', { name: NAME })),
      )
      expect(onDisableNotify).toHaveBeenCalled()
    })

    it('points iOS browsers to the Home Screen app', async () => {
      notify.notificationSupport.mockReturnValue('unsupported')
      notify.needsHomeScreenApp.mockReturnValue(true)
      const { sw } = await renderReady()
      expect(
        screen.getByText(
          'iPhone/iPad: works only from the Home Screen app (iOS 16.4+)',
        ),
      ).toBeInTheDocument()
      expect(sw).toBeDisabled()
    })

    it('stays off when the permission is not given', async () => {
      notify.requestNotify.mockResolvedValue('denied')
      const { sw, onUpdateSetting } = await renderReady()
      await act(async () => fireEvent.click(sw))
      expect(onUpdateSetting).not.toHaveBeenCalled()
      expect(
        screen.getByText('Blocked in browser settings'),
      ).toBeInTheDocument()
      expect(sw).toBeDisabled()
    })

    it('turns off without asking', async () => {
      notify.notificationSupport.mockReturnValue('granted')
      const { sw, onUpdateSetting } = await renderReady({ notifyAgents: true })
      expect(sw).toHaveAttribute('aria-checked', 'true')
      await act(async () => fireEvent.click(sw))
      expect(notify.requestNotify).not.toHaveBeenCalled()
      expect(onUpdateSetting).toHaveBeenCalledWith('notifyAgents', false)
    })

    it('reads as off and blocked once the browser denies it', async () => {
      notify.notificationSupport.mockReturnValue('denied')
      const { sw } = await renderReady({ notifyAgents: true })
      expect(sw).toHaveAttribute('aria-checked', 'false')
      expect(sw).toBeDisabled()
      expect(
        screen.getByText('Blocked in browser settings'),
      ).toBeInTheDocument()
    })

    it('asks for a reload while an older worker is active', async () => {
      notify.notifyWorkerReady.mockResolvedValue(false)
      const { sw } = await renderReady()
      expect(screen.getByText('Reload to turn on')).toBeInTheDocument()
      expect(sw).toBeDisabled()
    })

    it('ignores the worker answer after closing', async () => {
      let answer = (_: boolean) => {}
      notify.notifyWorkerReady.mockReturnValue(
        new Promise((r) => {
          answer = r
        }),
      )
      const { unmount } = renderModal()
      unmount()
      await act(async () => answer(false))
    })
  })
})

describe('SettingsModal for a view-only device or with devices', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi
      .fn()
      .mockImplementation(function (this: HTMLDialogElement) {
        this.removeAttribute('hidden')
        this.style.display = 'block'
      })
    HTMLDialogElement.prototype.close = vi.fn().mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.style.display = 'none'
    })
    notify.notificationSupport.mockReturnValue('default')
    notify.notifyWorkerReady.mockResolvedValue(true)
  })

  const renderWith = (props: Record<string, unknown>) =>
    render(
      <SettingsModal
        isOpen
        onClose={vi.fn()}
        settings={DEFAULT_SETTINGS}
        onUpdateSetting={vi.fn()}
        {...props}
      />,
      { wrapper: ThemeProvider },
    )

  it('has no Devices group unless the server offers devices', () => {
    renderWith({})
    expect(screen.queryByRole('button', { name: 'Devices' })).toBeNull()
  })

  it('shows the Shortcuts group after Keyboard on desktop only', () => {
    const { unmount } = renderWith({})
    expect(screen.queryByRole('button', { name: 'Shortcuts' })).toBeNull()
    unmount()
    renderWith({
      shortcuts: [
        {
          id: 'app.help',
          title: 'Show help',
          category: 'App',
          run: vi.fn(),
        },
      ],
      initialGroup: 'shortcuts',
    })
    const rail = screen.getByRole('navigation', { name: 'Settings groups' })
    const names = within(rail)
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(names.indexOf('Shortcuts')).toBe(names.indexOf('Keyboard') + 1)
    expect(screen.getByRole('button', { name: 'Shortcuts' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    expect(
      screen.getByRole('button', { name: 'Change the key of Show help' }),
    ).toBeVisible()
  })

  it('shows the Devices group with the section in it', () => {
    renderWith({ devices: true })
    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    expect(screen.getByTestId('devices-section')).toBeInTheDocument()
  })

  it('shows the Signed-in browsers group only when the server offers it', () => {
    const { unmount } = renderWith({})
    expect(
      screen.queryByRole('button', { name: 'Signed-in browsers' }),
    ).toBeNull()
    unmount()
    const onLogout = vi.fn()
    renderWith({ signins: true, onLogout })
    fireEvent.click(screen.getByRole('button', { name: 'Signed-in browsers' }))
    // Signing this browser out is the app's Log out
    fireEvent.click(screen.getByTestId('signins-section'))
    expect(onLogout).toHaveBeenCalledTimes(1)
  })

  it('shows the Prompt templates group only when the server keeps them', () => {
    const { unmount } = renderWith({})
    expect(
      screen.queryByRole('button', { name: 'Prompt templates' }),
    ).toBeNull()
    unmount()
    renderWith({ templates: true, readOnly: true })
    fireEvent.click(screen.getByRole('button', { name: 'Prompt templates' }))
    expect(screen.getByTestId('templates-section')).toHaveAttribute(
      'data-read-only',
      'true',
    )
  })

  it('shows the Tasks group only to a full device whose server has tasks', () => {
    const { unmount } = renderWith({})
    expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull()
    unmount()
    const view = renderWith({ tasks: true, userTasks: true, readOnly: true })
    expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull()
    view.unmount()
    renderWith({ tasks: true })
    expect(screen.getByRole('button', { name: 'Tasks' })).toBeInTheDocument()
  })

  it('the Tasks group offers the history read for Send to agent with tasks', () => {
    const onUpdateSetting = vi.fn()
    renderWith({ tasks: true, onUpdateSetting })
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    const select = screen.getByRole('combobox', {
      name: 'History read for Send to agent',
    })
    expect(select).toHaveValue('400')
    expect(
      Array.from((select as HTMLSelectElement).options).map((o) => o.text),
    ).toEqual([
      '100 lines',
      '200 lines',
      '400 lines',
      '1000 lines',
      '2000 lines',
      '5000 lines',
    ])
    fireEvent.change(select, { target: { value: '1000' } })
    expect(onUpdateSetting).toHaveBeenCalledWith('taskHistoryLines', 1000)
    expect(screen.queryByTestId('user-tasks-section')).toBeNull()
  })

  it('the Tasks group lists the user tasks, without the history select, with userTasks only', () => {
    renderWith({ userTasks: true })
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    expect(screen.getByTestId('user-tasks-section')).toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', {
        name: 'History read for Send to agent',
      }),
    ).toBeNull()
  })

  it('offers notifications to a full device', async () => {
    renderWith({})
    await waitFor(() => expect(notify.notifyWorkerReady).toHaveBeenCalled())
    expect(
      screen.getByRole('switch', { name: 'Notify when an agent needs me' }),
    ).toBeInTheDocument()
  })

  it('a view-only device gets no notification switch, since that would subscribe it to Web Push', async () => {
    renderWith({ readOnly: true })
    await act(async () => {})
    expect(
      screen.queryByRole('switch', { name: 'Notify when an agent needs me' }),
    ).toBeNull()
    expect(notify.notifyWorkerReady).not.toHaveBeenCalled()
  })
})

describe('SettingsModal on a phone', () => {
  const desktopMatchMedia = window.matchMedia
  // The width listeners, to cross the 768px line while open
  const widthListeners = new Set<(e: { matches: boolean }) => void>()
  let phone = true

  beforeEach(() => {
    phone = true
    widthListeners.clear()
    type Listener = (e: { matches: boolean }) => void
    window.matchMedia = ((query: string) => ({
      ...desktopMatchMedia(query),
      matches: query === '(max-width: 767px)' && phone,
      addEventListener: (_: string, fn: Listener) => {
        if (query === '(max-width: 767px)') widthListeners.add(fn)
      },
      removeEventListener: (_: string, fn: Listener) => {
        widthListeners.delete(fn)
      },
    })) as unknown as typeof window.matchMedia
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })
  afterEach(async () => {
    window.matchMedia = desktopMatchMedia
    // Unmounted inside a group, a test leaves a Back in flight: the next
    // one starts once it has landed
    cleanup()
    await waitFor(() => expect(viewerClosing()).toBe(false))
  })

  const setPhone = (on: boolean) =>
    act(() => {
      phone = on
      for (const fn of widthListeners) fn({ matches: on })
    })

  function renderPhone(
    overrides: Partial<Parameters<typeof SettingsModal>[0]> = {},
  ) {
    const onClose = vi.fn()
    const props = {
      isOpen: true,
      onClose,
      settings: DEFAULT_SETTINGS,
      onUpdateSetting: vi.fn(),
      ...overrides,
    }
    const view = render(<SettingsModal {...props} />, {
      wrapper: ThemeProvider,
    })
    return { ...view, onClose, props }
  }

  const list = () =>
    screen.queryByRole('navigation', { name: 'Settings groups' })
  const back = () => screen.queryByRole('button', { name: 'Back to Settings' })
  // Back from the history: pops the group's entry, as a gesture would
  const historyBack = async () => {
    await act(async () => {
      window.history.back()
      await new Promise((r) => setTimeout(r, 20))
    })
  }

  it('opens at the list of groups, with no rows of any', () => {
    renderPhone()
    expect(list()).toBeInTheDocument()
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(back()).toBeNull()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Settings' }),
    ).toBeInTheDocument()
    // No group is "current" in a list that only opens them
    expect(
      within(list()!).getByRole('button', { name: 'Keyboard' }),
    ).not.toHaveAttribute('aria-current')
  })

  it('sums up Appearance and Keyboard under their names', () => {
    localStorage.setItem('termote-theme', 'dark')
    renderPhone({
      settings: {
        ...DEFAULT_SETTINGS,
        uiStyle: 'terminal',
        language: 'vi',
        imeSendBehavior: 'send-enter',
      },
    })
    const nav = list()!
    expect(
      within(nav).getByRole('button', { name: 'Appearance' }),
    ).toHaveAccessibleDescription('Terminal · Dark · Tiếng Việt')
    expect(
      within(nav).getByRole('button', { name: 'Keyboard' }),
    ).toHaveAccessibleDescription('Send + Enter')
    expect(
      within(nav).getByRole('button', { name: 'Sessions' }),
    ).not.toHaveAttribute('aria-describedby')
  })

  it('opens one group with a way back, and goes back to the list on ‹', async () => {
    const before = window.history.length
    renderPhone()
    fireEvent.click(within(list()!).getByRole('button', { name: 'Keyboard' }))
    expect(list()).toBeNull()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Keyboard' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('region')).toHaveLength(1)
    expect(
      screen.getByRole('radiogroup', { name: 'Text input send behavior' }),
    ).toBeInTheDocument()
    expect(window.history.length).toBe(before + 1)

    fireEvent.click(back()!)
    await waitFor(() => expect(list()).toBeInTheDocument())
    // Focus is back on the group just left
    expect(
      within(list()!).getByRole('button', { name: 'Keyboard' }),
    ).toHaveFocus()
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('goes back to the list on Back of the history, staying open', async () => {
    const { onClose } = renderPhone()
    fireEvent.click(within(list()!).getByRole('button', { name: 'Sessions' }))
    expect(back()).toBeInTheDocument()
    await historyBack()
    await waitFor(() => expect(list()).toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
    expect(back()).toBeNull()
  })

  it('waits for the Back of the group just left before opening another', async () => {
    const { rerender, props } = renderPhone()
    fireEvent.click(within(list()!).getByRole('button', { name: 'Keyboard' }))
    const length = window.history.length
    // Closed from inside a group, then opened again before the Back that
    // takes its entry off has landed: a tap only names the group meanwhile
    rerender(<SettingsModal {...props} isOpen={false} />)
    rerender(<SettingsModal {...props} isOpen />)
    fireEvent.click(within(list()!).getByRole('button', { name: 'Terminal' }))
    fireEvent.click(within(list()!).getByRole('button', { name: 'Sessions' }))
    expect(list()).toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 2, name: 'Sessions' }),
      ).toBeInTheDocument(),
    )
    // One entry of its own on top, not one under the old: Back leaves it
    expect(window.history.state).toHaveProperty('termoteViewer')
    expect(window.history.length).toBe(length)
    await historyBack()
    await waitFor(() => expect(list()).toBeInTheDocument())
  })

  const cancel = () =>
    fireEvent(document.querySelector('dialog')!, new Event('cancel'))

  it('closes on Escape from inside a group', () => {
    const { onClose } = renderPhone()
    fireEvent.click(within(list()!).getByRole('button', { name: 'Keyboard' }))
    // The key, then the close request it makes
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    cancel()
    expect(onClose).toHaveBeenCalled()
  })

  it("goes back to the list on Android's Back, a close request without Escape", async () => {
    const { onClose } = renderPhone()
    fireEvent.click(within(list()!).getByRole('button', { name: 'Keyboard' }))
    cancel()
    await waitFor(() => expect(list()).toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
    // At the list it closes Settings
    cancel()
    expect(onClose).toHaveBeenCalled()
  })

  it('focuses the way back once a group opens from the list', () => {
    renderPhone()
    fireEvent.click(within(list()!).getByRole('button', { name: 'Keyboard' }))
    expect(back()).toHaveFocus()
  })

  it('stays in the group on Back while a sheet of it is open over it', async () => {
    renderPhone()
    fireEvent.click(within(list()!).getByRole('button', { name: 'Keyboard' }))
    // A sheet the group opened (a template editor, a confirmation)
    const child = document.createElement('dialog')
    child.setAttribute('open', '')
    document.body.append(child)
    try {
      await historyBack()
      // Still in the group, with its own entry pushed again
      await waitFor(() =>
        expect(window.history.state).toHaveProperty('termoteViewer'),
      )
      expect(list()).toBeNull()
      expect(back()).toBeInTheDocument()
    } finally {
      child.remove()
    }
    await historyBack()
    await waitFor(() => expect(list()).toBeInTheDocument())
  })

  it('takes its history entry off when closed from inside a group', async () => {
    const { rerender, props } = renderPhone()
    fireEvent.click(within(list()!).getByRole('button', { name: 'Keyboard' }))
    const pushed = window.history.state
    expect(pushed).toHaveProperty('termoteViewer')
    rerender(<SettingsModal {...props} isOpen={false} />)
    await waitFor(() =>
      expect(window.history.state?.termoteViewer).toBeUndefined(),
    )
    // Opened again: at the list, not the group left
    rerender(<SettingsModal {...props} isOpen />)
    expect(list()).toBeInTheDocument()
  })

  it('opens straight at the group it is given', () => {
    renderPhone({
      initialGroup: 'updates',
      updates: {
        server: null,
        stale: false,
        reloading: false,
        onReload: vi.fn(),
      },
    })
    expect(list()).toBeNull()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Updates' }),
    ).toBeInTheDocument()
    expect(screen.getByTestId('updates-section')).toBeInTheDocument()
    expect(back()).toBeInTheDocument()
  })

  it('opens a group at its top', () => {
    renderPhone()
    const body = document.querySelector('dialog .overflow-y-auto')!
    body.scrollTop = 300
    fireEvent.click(within(list()!).getByRole('button', { name: 'Sessions' }))
    expect(body.scrollTop).toBe(0)
  })

  it('follows the width across 768px while open', async () => {
    renderPhone()
    fireEvent.click(within(list()!).getByRole('button', { name: 'Keyboard' }))
    // Wider: the group open is the one picked in the rail
    setPhone(false)
    expect(
      within(list()!).getByRole('button', { name: 'Keyboard' }),
    ).toHaveAttribute('aria-current', 'true')
    expect(back()).toBeNull()
    // Narrower again: the list
    setPhone(true)
    expect(list()).toBeInTheDocument()
    expect(screen.queryByRole('region')).toBeNull()
  })
})
