import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SettingsModal } from './settings-modal'
import type { Settings } from '../hooks/use-settings'

const DEFAULT_SETTINGS: Settings = {
  imeSendBehavior: 'send-only',
  pasteSource: 'clipboard',
  toolbarDefaultExpanded: false,
  disableContextMenu: true,
  showSessionTabs: false,
  pollInterval: 5,
  hasSeenGestureHints: false,
}

// jsdom does not show <dialog> as visible; force it open by removing hidden attribute
function openDialog() {
  const dialog = document.querySelector('dialog')
  if (dialog) {
    dialog.removeAttribute('hidden')
    // Also remove display:none that jsdom may apply
    ;(dialog as HTMLElement).style.display = 'block'
  }
}

describe('SettingsModal', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn().mockImplementation(function (this: HTMLDialogElement) {
      this.removeAttribute('hidden')
      this.style.display = 'block'
    })
    HTMLDialogElement.prototype.close = vi.fn().mockImplementation(function (this: HTMLDialogElement) {
      this.style.display = 'none'
    })
  })

  function renderModal(overrides: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
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
    const closeBtn = document.querySelector('button[aria-label="Close"]') as HTMLElement
    expect(closeBtn).toBeTruthy()
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when dialog backdrop clicked (target === currentTarget)', () => {
    const { onClose } = renderModal()
    const dialog = document.querySelector('dialog')!
    // Simulate click where target IS the dialog itself
    Object.defineProperty(dialog, 'currentTarget', { value: dialog, configurable: true })
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
    const { onUpdateSetting, container } = renderModal()
    const sendEnterRadio = container.querySelector('input[value="send-enter"]') as HTMLInputElement
    expect(sendEnterRadio).toBeTruthy()
    fireEvent.click(sendEnterRadio)
    expect(onUpdateSetting).toHaveBeenCalledWith('imeSendBehavior', 'send-enter')
  })

  it('updates imeSendBehavior when send-only radio selected', () => {
    const { onUpdateSetting, container } = renderModal({
      settings: { ...DEFAULT_SETTINGS, imeSendBehavior: 'send-enter' },
    })
    const sendOnlyRadio = container.querySelector('input[value="send-only"]') as HTMLInputElement
    fireEvent.click(sendOnlyRadio)
    expect(onUpdateSetting).toHaveBeenCalledWith('imeSendBehavior', 'send-only')
  })

  it('updates pasteSource when tmux radio selected', () => {
    const { onUpdateSetting, container } = renderModal()
    const tmuxRadio = container.querySelector('input[value="tmux"]') as HTMLInputElement
    fireEvent.click(tmuxRadio)
    expect(onUpdateSetting).toHaveBeenCalledWith('pasteSource', 'tmux')
  })

  it('updates pasteSource when clipboard radio selected', () => {
    const { onUpdateSetting, container } = renderModal({
      settings: { ...DEFAULT_SETTINGS, pasteSource: 'tmux' },
    })
    const clipRadio = container.querySelector('input[value="clipboard"]') as HTMLInputElement
    fireEvent.click(clipRadio)
    expect(onUpdateSetting).toHaveBeenCalledWith('pasteSource', 'clipboard')
  })

  it('toggles toolbarDefaultExpanded', () => {
    const { onUpdateSetting } = renderModal()
    const switches = document.querySelectorAll('button[role="switch"]')
    fireEvent.click(switches[0])
    expect(onUpdateSetting).toHaveBeenCalledWith('toolbarDefaultExpanded', true)
  })

  it('toggles disableContextMenu', () => {
    const { onUpdateSetting } = renderModal()
    const switches = document.querySelectorAll('button[role="switch"]')
    fireEvent.click(switches[1])
    expect(onUpdateSetting).toHaveBeenCalledWith('disableContextMenu', false)
  })

  it('toggles showSessionTabs', () => {
    const { onUpdateSetting } = renderModal()
    const switches = document.querySelectorAll('button[role="switch"]')
    fireEvent.click(switches[2])
    expect(onUpdateSetting).toHaveBeenCalledWith('showSessionTabs', true)
  })

  it('updates pollInterval via select', () => {
    const { onUpdateSetting } = renderModal()
    const select = document.querySelector('select') as HTMLSelectElement
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
    const btn = document.querySelector('button.text-blue-600') as HTMLElement
    expect(document.body.textContent).toContain('Show Gesture Hints')
  })

  it('calls onShowGestureHints when button clicked', () => {
    const onShowGestureHints = vi.fn()
    renderModal({ onShowGestureHints })
    const btns = document.querySelectorAll('button')
    const gestureBtn = Array.from(btns).find(b => b.textContent?.includes('Show Gesture Hints'))!
    fireEvent.click(gestureBtn)
    expect(onShowGestureHints).toHaveBeenCalled()
  })

  it('renders Check for Updates button when handler provided', () => {
    const onCheckForUpdate = vi.fn().mockResolvedValue(null)
    renderModal({ onCheckForUpdate })
    expect(document.body.textContent).toContain('Check for Updates')
  })

  it('disables Check for Updates button when updateChecking is true', () => {
    const onCheckForUpdate = vi.fn().mockResolvedValue(null)
    renderModal({ onCheckForUpdate, updateChecking: true })
    const btns = document.querySelectorAll('button')
    const checkBtn = Array.from(btns).find(b => b.textContent?.includes('Checking'))! as HTMLButtonElement
    expect(checkBtn.disabled).toBe(true)
  })

  it('shows inline toast when onCheckForUpdate returns a message', async () => {
    const onCheckForUpdate = vi.fn().mockResolvedValue('Update available: v1.2.3')
    const { container } = renderModal({ onCheckForUpdate })
    const checkBtn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Check for Updates'))!
    await act(async () => { fireEvent.click(checkBtn) })
    expect(document.body.textContent).toContain('Update available: v1.2.3')
  })

  it('hides inline toast after 4 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const onCheckForUpdate = vi.fn().mockResolvedValue('Update available!')
    const { container } = renderModal({ onCheckForUpdate })
    const checkBtn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Check for Updates'))!
    await act(async () => { fireEvent.click(checkBtn) })
    expect(document.body.textContent).toContain('Update available!')
    act(() => { vi.advanceTimersByTime(4001) })
    expect(document.body.textContent).not.toContain('Update available!')
    vi.useRealTimers()
  })

  it('does not show toast when onCheckForUpdate returns null', async () => {
    const onCheckForUpdate = vi.fn().mockResolvedValue(null)
    const { container } = renderModal({ onCheckForUpdate })
    const checkBtn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Check for Updates'))!
    await act(async () => { fireEvent.click(checkBtn) })
    expect(document.body.textContent).not.toContain('Update available')
  })

  it('clears previous toast timer when update button clicked again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const onCheckForUpdate = vi.fn()
      .mockResolvedValueOnce('First message')
      .mockResolvedValue('Second message')
    const { container } = renderModal({ onCheckForUpdate })
    const checkBtn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('Check for Updates'))!
    await act(async () => { fireEvent.click(checkBtn) })
    expect(document.body.textContent).toContain('First message')
    await act(async () => { fireEvent.click(checkBtn) })
    expect(document.body.textContent).toContain('Second message')
    vi.useRealTimers()
  })

  it('cleans up toast timer on unmount', () => {
    vi.useFakeTimers()
    const onCheckForUpdate = vi.fn().mockResolvedValue('msg')
    const { unmount } = render(
      <SettingsModal
        isOpen={true}
        onClose={vi.fn()}
        settings={DEFAULT_SETTINGS}
        onUpdateSetting={vi.fn()}
        onCheckForUpdate={onCheckForUpdate}
      />,
    )
    unmount()
    act(() => { vi.advanceTimersByTime(5000) })
    vi.useRealTimers()
    // No error = pass
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
    const clearBtn = Array.from(btns).find(b => b.textContent?.includes('Clear Command History'))! as HTMLButtonElement
    expect(clearBtn.disabled).toBe(true)
  })

  it('calls onClearHistory when button clicked', () => {
    const onClearHistory = vi.fn()
    renderModal({ onClearHistory, historyCount: 3 })
    const btns = document.querySelectorAll('button')
    const clearBtn = Array.from(btns).find(b => b.textContent?.includes('Clear Command History'))!
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
    const onCheckForUpdate = vi.fn().mockResolvedValue(null)
    const onClearHistory = vi.fn()
    renderModal({ onShowGestureHints, onCheckForUpdate, onClearHistory, historyCount: 1 })
    expect(document.body.textContent).toContain('Show Gesture Hints')
    expect(document.body.textContent).toContain('Check for Updates')
    expect(document.body.textContent).toContain('Clear Command History')
  })

  it('ToggleRow renders checked state visually (aria-checked=true)', () => {
    renderModal({ settings: { ...DEFAULT_SETTINGS, toolbarDefaultExpanded: true } })
    const switches = document.querySelectorAll('button[role="switch"]')
    expect(switches[0].getAttribute('aria-checked')).toBe('true')
  })

  it('ToggleRow renders unchecked state visually (aria-checked=false)', () => {
    renderModal({ settings: { ...DEFAULT_SETTINGS, toolbarDefaultExpanded: false } })
    const switches = document.querySelectorAll('button[role="switch"]')
    expect(switches[0].getAttribute('aria-checked')).toBe('false')
  })

  it('Settings heading is present', () => {
    renderModal()
    expect(document.body.textContent).toContain('Settings')
  })

  it('poll interval select has correct options', () => {
    renderModal()
    const select = document.querySelector('select') as HTMLSelectElement
    const options = Array.from(select.options).map(o => o.value)
    expect(options).toContain('3')
    expect(options).toContain('60')
    expect(options).toContain('300')
  })

  it('IME send behavior radio group has both options', () => {
    renderModal()
    const sendOnlyRadio = document.querySelector('input[value="send-only"]')
    const sendEnterRadio = document.querySelector('input[value="send-enter"]')
    expect(sendOnlyRadio).toBeInTheDocument()
    expect(sendEnterRadio).toBeInTheDocument()
  })

  it('paste source radio group has both options', () => {
    renderModal()
    const clipboardRadio = document.querySelector('input[value="clipboard"]')
    const tmuxRadio = document.querySelector('input[value="tmux"]')
    expect(clipboardRadio).toBeInTheDocument()
    expect(tmuxRadio).toBeInTheDocument()
  })
})
