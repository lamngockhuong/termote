import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const DEFAULT_SETTINGS: Settings = {
  imeSendBehavior: 'send-only',
  pasteSource: 'clipboard',
  toolbarDefaultExpanded: false,
  disableContextMenu: true,
  copyOnSelect: false,
  showSessionTabs: false,
  pollInterval: 5,
  hasSeenGestureHints: false,
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
  notifyAgents: false,
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
    const result = render(<SettingsModal {...props} />)
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
    // Every group is in the page; the CSS hides the inactive ones at md+
    expect(section('appearance')).not.toHaveClass('md:hidden')
    expect(section('keyboard')).toHaveClass('md:hidden')
    const nav = screen.getByRole('navigation', { name: 'Settings groups' })
    const keyboard = within(nav).getByRole('button', { name: 'Keyboard' })
    fireEvent.click(keyboard)
    expect(section('keyboard')).not.toHaveClass('md:hidden')
    expect(section('appearance')).toHaveClass('md:hidden')
    expect(keyboard).toHaveAttribute('aria-current', 'true')
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
    renderModal({ onShowGestureHints: vi.fn() })
    expect(
      within(nav()).getByRole('button', { name: 'Data & help' }),
    ).toBeInTheDocument()
  })

  it('falls back to the first group when the open one goes away', () => {
    const { rerender, onClose } = renderModal({ onShowGestureHints: vi.fn() })
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
    expect(document.body.textContent).not.toContain('Show Gesture Hints')
    expect(document.body.textContent).not.toContain('Check for Updates')
    expect(document.body.textContent).not.toContain('Clear Command History')
  })

  it('renders Show Gesture Hints button when handler provided', () => {
    const onShowGestureHints = vi.fn()
    renderModal({ onShowGestureHints })
    expect(document.body.textContent).toContain('Show Gesture Hints')
  })

  it('calls onShowGestureHints when button clicked', () => {
    const onShowGestureHints = vi.fn()
    renderModal({ onShowGestureHints })
    const btns = document.querySelectorAll('button')
    const gestureBtn = Array.from(btns).find((b) =>
      b.textContent?.includes('Show Gesture Hints'),
    )!
    fireEvent.click(gestureBtn)
    expect(onShowGestureHints).toHaveBeenCalled()
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
    const onShowGestureHints = vi.fn()
    const onClearHistory = vi.fn()
    renderModal({
      onShowGestureHints,
      onClearHistory,
      historyCount: 1,
    })
    expect(document.body.textContent).toContain('Show Gesture Hints')
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
    const select = document.querySelector('select') as HTMLSelectElement
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
    )

  it('has no Devices group unless the server offers devices', () => {
    renderWith({})
    expect(screen.queryByRole('button', { name: 'Devices' })).toBeNull()
  })

  it('shows the Devices group with the section in it', () => {
    renderWith({ devices: true })
    fireEvent.click(screen.getByRole('button', { name: 'Devices' }))
    expect(screen.getByTestId('devices-section')).toBeInTheDocument()
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
