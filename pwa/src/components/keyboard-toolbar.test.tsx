import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeyboardToolbar } from './keyboard-toolbar'

vi.mock('../hooks/use-haptic', () => ({
  useHaptic: () => ({ trigger: vi.fn(), isSupported: false }),
}))

describe('KeyboardToolbar', () => {
  let onKey: (...args: any[]) => any
  let onCtrlKey: (...args: any[]) => any
  let onShiftKey: (...args: any[]) => any
  let onCtrlShiftKey: (...args: any[]) => any
  let onScroll: (...args: any[]) => any
  let onTmuxCopy: (...args: any[]) => any
  let onPaste: (...args: any[]) => any
  let onToggleKeyboard: (...args: any[]) => any
  let onSendText: (...args: any[]) => any
  let onCtrlChange: (...args: any[]) => any
  let onShiftChange: (...args: any[]) => any
  let onImeModeChange: (...args: any[]) => any
  let onHistoryToggle: (...args: any[]) => any
  let onSelectText: (...args: any[]) => any
  let onAttachImage: (...args: any[]) => any

  beforeEach(() => {
    onKey = vi.fn()
    onCtrlKey = vi.fn()
    onShiftKey = vi.fn()
    onCtrlShiftKey = vi.fn()
    onScroll = vi.fn()
    onTmuxCopy = vi.fn()
    onPaste = vi.fn()
    onToggleKeyboard = vi.fn()
    onSendText = vi.fn()
    onCtrlChange = vi.fn()
    onShiftChange = vi.fn()
    onImeModeChange = vi.fn()
    onHistoryToggle = vi.fn()
    onSelectText = vi.fn()
    onAttachImage = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function renderToolbar(
    props: Partial<Parameters<typeof KeyboardToolbar>[0]> = {},
  ) {
    return render(
      <KeyboardToolbar
        onKey={onKey}
        onCtrlKey={onCtrlKey}
        onShiftKey={onShiftKey}
        onCtrlShiftKey={onCtrlShiftKey}
        onScroll={onScroll}
        onTmuxCopy={onTmuxCopy}
        onPaste={onPaste}
        onToggleKeyboard={onToggleKeyboard}
        onSendText={onSendText}
        onCtrlChange={onCtrlChange}
        onShiftChange={onShiftChange}
        onImeModeChange={onImeModeChange}
        onHistoryToggle={onHistoryToggle}
        onSelectText={onSelectText}
        onAttachImage={onAttachImage}
        {...props}
      />,
    )
  }

  describe('Main row layout', () => {
    it('renders main row keys in order: Keyboard, IME, Esc, Ctrl, ArrowUp, ArrowDown, Enter, Tab', () => {
      renderToolbar({ onSendText: undefined })
      const scroller = screen.getByTestId('toolbar-scroller')
      const keys = within(scroller).getAllByRole('button')
      // ImeToggle is filtered out when no onSendText
      const labels = keys.map((k) => k.getAttribute('data-key'))
      expect(labels).toEqual([
        'Keyboard',
        'Escape',
        'Control',
        'ArrowUp',
        'ArrowDown',
        'Enter',
        'Tab',
      ])
    })

    it('includes ImeToggle when onSendText provided', () => {
      renderToolbar({ onSendText })
      const scroller = screen.getByTestId('toolbar-scroller')
      const keys = within(scroller).getAllByRole('button')
      const labels = keys.map((k) => k.getAttribute('data-key'))
      expect(labels).toEqual([
        'Keyboard',
        'ImeToggle',
        'Escape',
        'Control',
        'ArrowUp',
        'ArrowDown',
        'Enter',
        'Tab',
      ])
    })

    it('renders More key pinned outside the scroller', () => {
      renderToolbar()
      const moreKey = screen.getByLabelText('Extra keys')
      expect(moreKey).toBeInTheDocument()
      expect(moreKey).toHaveAttribute('data-key', 'More')
    })

    it('More key has aria-expanded attribute', () => {
      renderToolbar()
      const moreKey = screen.getByLabelText('Extra keys')
      expect(moreKey).toHaveAttribute('aria-expanded', 'false')
    })

    it('More key aria-expanded changes when clicked', () => {
      renderToolbar()
      const moreKey = screen.getByLabelText('Extra keys')
      expect(moreKey).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(moreKey)
      expect(moreKey).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(moreKey)
      expect(moreKey).toHaveAttribute('aria-expanded', 'false')
    })
  })

  describe('Key press handlers', () => {
    it('sends Tab key', () => {
      renderToolbar()
      fireEvent.click(screen.getByText('Tab'))
      expect(onKey).toHaveBeenCalledWith('Tab')
    })

    it('sends Esc key', () => {
      renderToolbar()
      fireEvent.click(screen.getByText('Esc'))
      expect(onKey).toHaveBeenCalledWith('Escape')
    })

    it('toggles Ctrl mode on Ctrl click', () => {
      renderToolbar()
      fireEvent.click(screen.getByText('Ctrl'))
      expect(onCtrlChange).toHaveBeenCalledWith(true)
      fireEvent.click(screen.getByText('Ctrl'))
      expect(onCtrlChange).toHaveBeenCalledWith(false)
    })

    it('sends ArrowUp key', () => {
      renderToolbar()
      const upButton = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-key') === 'ArrowUp')
      fireEvent.click(upButton!)
      expect(onKey).toHaveBeenCalledWith('ArrowUp')
    })

    it('sends ArrowDown key', () => {
      renderToolbar()
      const downButton = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-key') === 'ArrowDown')
      fireEvent.click(downButton!)
      expect(onKey).toHaveBeenCalledWith('ArrowDown')
    })

    it('sends Enter key', () => {
      renderToolbar()
      // Enter icon button
      const buttons = within(
        screen.getByTestId('toolbar-scroller'),
      ).getAllByRole('button')
      const enterBtn = buttons.find(
        (b) => b.getAttribute('data-key') === 'Enter',
      )
      fireEvent.click(enterBtn!)
      expect(onKey).toHaveBeenCalledWith('Enter')
    })
  })

  describe('Expanded panel layout', () => {
    it('expanded panel is hidden when collapsed', () => {
      renderToolbar()
      expect(screen.queryByText('Actions')).not.toBeInTheDocument()
      expect(screen.queryByText('Navigate')).not.toBeInTheDocument()
    })

    it('shows expanded panel when More key clicked', () => {
      const mockQuickActions = { onSendKey: vi.fn(), onSendText: vi.fn() }
      renderToolbar({
        quickActions: mockQuickActions,
        onScroll,
        onSelectText,
        onAttachImage,
        onHistoryToggle,
        showTmuxCopy: false,
      })
      const moreKey = screen.getByLabelText('Extra keys')
      fireEvent.click(moreKey)
      expect(screen.getByText('Actions')).toBeInTheDocument()
      expect(screen.getByText('Navigate')).toBeInTheDocument()
      expect(screen.getByText('Text')).toBeInTheDocument()
      // When showTmuxCopy=false, the label is just 'Scroll'
      expect(screen.getByText(/^Scroll/)).toBeInTheDocument()
    })

    it('hides expanded panel when More key clicked again', () => {
      renderToolbar()
      const moreKey = screen.getByLabelText('Extra keys')
      fireEvent.click(moreKey)
      expect(screen.getByText('Navigate')).toBeInTheDocument()
      fireEvent.click(moreKey)
      expect(screen.queryByText('Navigate')).not.toBeInTheDocument()
    })

    it('starts expanded when defaultExpanded=true', () => {
      renderToolbar({ defaultExpanded: true })
      expect(screen.getByText('Navigate')).toBeInTheDocument()
      expect(screen.getByLabelText('Extra keys')).toHaveAttribute(
        'aria-expanded',
        'true',
      )
    })
  })

  describe('Panel: Actions row', () => {
    it('does not show Actions row when quickActions not provided', () => {
      renderToolbar({ defaultExpanded: true })
      expect(screen.queryByText('Actions')).not.toBeInTheDocument()
    })

    it('shows Actions row when quickActions provided', () => {
      renderToolbar({
        defaultExpanded: true,
        quickActions: {
          onSendKey: vi.fn(),
          onSendText: vi.fn(),
        },
      })
      expect(screen.getByText('Actions')).toBeInTheDocument()
    })

    it('shows Clear, Cancel, Clear line, Exit buttons in Actions', () => {
      renderToolbar({
        defaultExpanded: true,
        quickActions: {
          onSendKey: vi.fn(),
          onSendText: vi.fn(),
        },
      })
      expect(screen.getByText('Clear')).toBeInTheDocument()
      expect(screen.getByText('Cancel')).toBeInTheDocument()
      expect(screen.getByText('Clear line')).toBeInTheDocument()
      expect(screen.getByText('Exit')).toBeInTheDocument()
    })

    it('Clear action sends text then Enter', () => {
      const onSendKey = vi.fn()
      const onSendText = vi.fn()
      renderToolbar({
        defaultExpanded: true,
        quickActions: { onSendKey, onSendText },
      })
      fireEvent.click(screen.getByText('Clear'))
      expect(onSendText).toHaveBeenCalledWith('clear')
      expect(onSendKey).toHaveBeenCalledWith('Enter')
    })

    it('Cancel sends Ctrl+C', () => {
      const onSendKey = vi.fn()
      renderToolbar({
        defaultExpanded: true,
        quickActions: { onSendKey, onSendText: vi.fn() },
      })
      fireEvent.click(screen.getByText('Cancel'))
      expect(onSendKey).toHaveBeenCalledWith('c', { ctrl: true })
    })
  })

  describe('Panel: Text row', () => {
    it('shows Text row when expanded', () => {
      renderToolbar({ defaultExpanded: true })
      expect(screen.getByText('Text')).toBeInTheDocument()
    })

    it('Text row always includes Paste button', () => {
      renderToolbar({ defaultExpanded: true, onPaste })
      const textGroup = screen.getByText('Text').closest('fieldset')
      // Text group should have at least one button (Paste)
      const buttons = within(textGroup!).getAllByRole('button')
      expect(buttons.length).toBeGreaterThanOrEqual(1)
    })

    it('Text row includes History toggle when onHistoryToggle provided', () => {
      renderToolbar({ defaultExpanded: true, onHistoryToggle })
      const textGroup = screen.getByText('Text').closest('fieldset')
      // History toggle is represented by a Clock icon
      expect(within(textGroup!).getAllByRole('button').length).toBeGreaterThan(
        0,
      )
    })

    it('Text row includes Attach image when onAttachImage provided', () => {
      renderToolbar({
        defaultExpanded: true,
        onAttachImage,
      })
      const textGroup = screen.getByText('Text').closest('fieldset')
      expect(
        within(textGroup!).getByLabelText('Attach image'),
      ).toBeInTheDocument()
    })

    it('Text row includes Select text when onSelectText provided', () => {
      renderToolbar({
        defaultExpanded: true,
        onSelectText,
      })
      const textGroup = screen.getByText('Text').closest('fieldset')
      expect(
        within(textGroup!).getByLabelText('Select text'),
      ).toBeInTheDocument()
    })

    it('Text row is empty when no handlers provided (but still shown with Paste)', () => {
      // Without onHistoryToggle, onAttachImage, onSelectText - but Paste is always there
      renderToolbar({ defaultExpanded: true })
      expect(screen.getByText('Text')).toBeInTheDocument()
    })
  })

  describe('Panel: Navigate row', () => {
    it('shows Navigate row with 11 keys when expanded', () => {
      renderToolbar({ defaultExpanded: true })
      const navGroup = screen.getByText('Navigate').closest('fieldset')
      expect(within(navGroup!).getAllByRole('button').length).toBe(11) // Shift, ShiftTab, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Delete, Backspace, Insert
    })

    it('Shift button toggles shift mode', () => {
      renderToolbar({ defaultExpanded: true })
      const navGroup = screen.getByText('Navigate').closest('fieldset')
      const shiftButton = within(navGroup!).getByText('Shift')
      fireEvent.click(shiftButton)
      expect(onShiftChange).toHaveBeenCalledWith(true)
    })

    it('ShiftTab sends Shift+Tab via onShiftKey', () => {
      renderToolbar({ defaultExpanded: true })
      const navGroup = screen.getByText('Navigate').closest('fieldset')
      const shiftTabButton = within(navGroup!).getByLabelText('Shift+Tab')
      fireEvent.click(shiftTabButton)
      expect(onShiftKey).toHaveBeenCalledWith('Tab')
    })

    it('ShiftTab clears Ctrl if active', () => {
      renderToolbar({ defaultExpanded: true, ctrlActive: true })
      const navGroup = screen.getByText('Navigate').closest('fieldset')
      const shiftTabButton = within(navGroup!).getByLabelText('Shift+Tab')
      fireEvent.click(shiftTabButton)
      expect(onCtrlChange).toHaveBeenCalledWith(false)
    })

    it('ShiftTab clears Shift if active', () => {
      renderToolbar({ defaultExpanded: true, shiftActive: true })
      const navGroup = screen.getByText('Navigate').closest('fieldset')
      const shiftTabButton = within(navGroup!).getByLabelText('Shift+Tab')
      fireEvent.click(shiftTabButton)
      expect(onShiftChange).toHaveBeenCalledWith(false)
    })
  })

  describe('Panel: Scroll row', () => {
    it('shows Scroll row with correct label when showTmuxCopy=false', () => {
      renderToolbar({ defaultExpanded: true, showTmuxCopy: false })
      expect(screen.getByText('Scroll')).toBeInTheDocument()
      expect(screen.queryByText('Scroll · copy mode')).not.toBeInTheDocument()
    })

    it('shows "Scroll · copy mode" label when showTmuxCopy=true', () => {
      renderToolbar({ defaultExpanded: true, showTmuxCopy: true, onTmuxCopy })
      expect(screen.getByText('Scroll · copy mode')).toBeInTheDocument()
    })

    it('includes tmux copy key when showTmuxCopy=true', () => {
      renderToolbar({ defaultExpanded: true, showTmuxCopy: true, onTmuxCopy })
      const scrollGroup = screen
        .getByText('Scroll · copy mode')
        .closest('fieldset')
      expect(within(scrollGroup!).getAllByRole('button').length).toBe(3) // copy mode, scroll up, scroll down
    })

    it('omits tmux copy key when showTmuxCopy=false', () => {
      renderToolbar({ defaultExpanded: true, showTmuxCopy: false })
      const scrollGroup = screen.getByText('Scroll').closest('fieldset')
      expect(within(scrollGroup!).getAllByRole('button').length).toBe(2) // scroll up, scroll down
    })

    it('scroll up calls onScroll with up', () => {
      renderToolbar({ defaultExpanded: true, onScroll, showTmuxCopy: false })
      const scrollGroup = screen.getByText('Scroll').closest('fieldset')
      const buttons = within(scrollGroup!).getAllByRole('button')
      fireEvent.click(buttons[0]) // First one should be scroll up
      expect(onScroll).toHaveBeenCalledWith('up')
    })

    it('scroll down calls onScroll with down', () => {
      renderToolbar({ defaultExpanded: true, onScroll, showTmuxCopy: false })
      const scrollGroup = screen.getByText('Scroll').closest('fieldset')
      const buttons = within(scrollGroup!).getAllByRole('button')
      fireEvent.click(buttons[1]) // Second one should be scroll down
      expect(onScroll).toHaveBeenCalledWith('down')
    })
  })

  describe('Ctrl combos overlay', () => {
    it('shows Ctrl combos overlay when ctrlActive=true and shiftActive=false', () => {
      renderToolbar({ ctrlActive: true, shiftActive: false })
      expect(screen.getByTestId('ctrl-combos-overlay')).toBeInTheDocument()
    })

    it('hides Ctrl combos overlay when ctrlActive=false', () => {
      renderToolbar({ ctrlActive: false })
      expect(
        screen.queryByTestId('ctrl-combos-overlay'),
      ).not.toBeInTheDocument()
    })

    it('shows Ctrl combos even when expanded=false', () => {
      renderToolbar({
        ctrlActive: true,
        shiftActive: false,
        defaultExpanded: false,
      })
      expect(screen.getByTestId('ctrl-combos-overlay')).toBeInTheDocument()
    })

    it('shows Ctrl combos even when expanded=true', () => {
      renderToolbar({
        ctrlActive: true,
        shiftActive: false,
        defaultExpanded: true,
      })
      expect(screen.getByTestId('ctrl-combos-overlay')).toBeInTheDocument()
    })

    it('shows 14 Ctrl combos', () => {
      renderToolbar({ ctrlActive: true, shiftActive: false })
      const overlay = screen.getByTestId('ctrl-combos-overlay')
      const buttons = within(overlay).getAllByRole('button')
      expect(buttons.length).toBe(14)
    })

    it('Ctrl combo buttons show ^prefix', () => {
      renderToolbar({ ctrlActive: true, shiftActive: false })
      const overlay = screen.getByTestId('ctrl-combos-overlay')
      const buttons = within(overlay).getAllByRole('button')
      // Check at least one button contains ^ prefix
      expect(buttons.some((b) => b.textContent?.includes('^'))).toBe(true)
    })
  })

  describe('Ctrl+Shift combos overlay', () => {
    it('shows Ctrl+Shift combos overlay when both ctrlActive and shiftActive', () => {
      renderToolbar({ ctrlActive: true, shiftActive: true })
      expect(
        screen.getByTestId('ctrl-shift-combos-overlay'),
      ).toBeInTheDocument()
    })

    it('hides Ctrl combos overlay when both active (shows Ctrl+Shift instead)', () => {
      renderToolbar({ ctrlActive: true, shiftActive: true })
      expect(
        screen.queryByTestId('ctrl-combos-overlay'),
      ).not.toBeInTheDocument()
    })

    it('shows 4 Ctrl+Shift combos', () => {
      renderToolbar({ ctrlActive: true, shiftActive: true })
      const overlay = screen.getByTestId('ctrl-shift-combos-overlay')
      const buttons = within(overlay).getAllByRole('button')
      expect(buttons.length).toBe(4)
    })

    it('Ctrl+Shift combo buttons show ^⇧prefix', () => {
      renderToolbar({ ctrlActive: true, shiftActive: true })
      const overlay = screen.getByTestId('ctrl-shift-combos-overlay')
      const html = overlay.innerHTML
      expect(html).toContain('^⇧')
    })
  })

  describe('Ctrl key handling', () => {
    it('shows Ctrl pressed state when ctrlActive=true', () => {
      renderToolbar({ ctrlActive: true })
      const ctrlButton = screen.getByText('Ctrl')
      expect(ctrlButton).toHaveAttribute('aria-pressed', 'true')
    })

    it('hides Ctrl pressed state when ctrlActive=false', () => {
      renderToolbar({ ctrlActive: false })
      const ctrlButton = screen.getByText('Ctrl')
      expect(ctrlButton).toHaveAttribute('aria-pressed', 'false')
    })

    it('sends Ctrl+key when a regular key is clicked with ctrlActive=true', () => {
      renderToolbar({ ctrlActive: true })
      const tabButton = screen.getByText('Tab')
      fireEvent.click(tabButton)
      expect(onCtrlKey).toHaveBeenCalledWith('Tab')
      expect(onCtrlChange).toHaveBeenCalledWith(false)
    })

    it('Escape clears ctrlActive', () => {
      renderToolbar({ ctrlActive: true })
      fireEvent.click(screen.getByText('Esc'))
      expect(onCtrlChange).toHaveBeenCalledWith(false)
    })
  })

  describe('IME mode', () => {
    it('renders IME input when imeMode=true', () => {
      renderToolbar({ imeMode: true })
      expect(
        screen.getByPlaceholderText(/Type non-Latin text/),
      ).toBeInTheDocument()
    })

    it('does not render main toolbar when imeMode=true', () => {
      renderToolbar({ imeMode: true })
      expect(screen.queryByTestId('toolbar-scroller')).not.toBeInTheDocument()
    })

    it('toggles imeMode on IME toggle button click', () => {
      renderToolbar({ onSendText })
      fireEvent.click(
        screen
          .getAllByRole('button')
          .find((b) => b.getAttribute('data-key') === 'ImeToggle')!,
      )
      expect(onImeModeChange).toHaveBeenCalledWith(true)
    })

    it('sends text via onSendText when IME input submitted', () => {
      const onSendTextMock = vi.fn()
      renderToolbar({ imeMode: true, onSendText: onSendTextMock })
      const input = screen.getByPlaceholderText(/Type non-Latin text/)
      fireEvent.change(input, { target: { value: 'hello' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onSendTextMock).toHaveBeenCalledWith('hello')
    })

    it('clears IME text after sending', () => {
      const onSendTextMock = vi.fn()
      renderToolbar({ imeMode: true, onSendText: onSendTextMock })
      const input = screen.getByPlaceholderText(
        /Type non-Latin text/,
      ) as HTMLInputElement
      fireEvent.change(input, { target: { value: 'hello' } })
      expect(input.value).toBe('hello')
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(input.value).toBe('')
    })

    it('close button exits IME mode', () => {
      renderToolbar({ imeMode: true })
      const closeButton = screen.getByLabelText('Close IME input')
      fireEvent.click(closeButton)
      expect(onImeModeChange).toHaveBeenCalledWith(false)
    })

    it('does not send on Enter while composing (IME)', () => {
      renderToolbar({ imeMode: true })
      const input = screen.getByPlaceholderText(/Type non-Latin text/)
      fireEvent.change(input, { target: { value: 'xin chào' } })
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      })
      Object.defineProperty(event, 'isComposing', { value: true })
      input.dispatchEvent(event)
      fireEvent.keyDown(input, { key: 'a' })
      expect(onSendText).not.toHaveBeenCalled()
    })

    it('ignores Enter key when text is empty', () => {
      const onSendTextMock = vi.fn()
      renderToolbar({ imeMode: true, onSendText: onSendTextMock })
      const input = screen.getByPlaceholderText(/Type non-Latin text/)
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onSendTextMock).not.toHaveBeenCalled()
    })
  })

  describe('History button', () => {
    it('shows History toggle when onHistoryToggle provided', () => {
      renderToolbar({ defaultExpanded: true, onHistoryToggle })
      const textGroup = screen.getByText('Text').closest('fieldset')
      const historyButtons = within(textGroup!).getAllByRole('button')
      expect(historyButtons.length).toBeGreaterThan(0)
    })

    it('calls onHistoryToggle when history button clicked', () => {
      const onHistoryToggleMock = vi.fn()
      renderToolbar({
        defaultExpanded: true,
        onHistoryToggle: onHistoryToggleMock,
      })
      const textGroup = screen.getByText('Text').closest('fieldset')
      const historyButton = within(textGroup!).getAllByRole('button')[0]
      fireEvent.click(historyButton)
      expect(onHistoryToggleMock).toHaveBeenCalled()
    })

    it('shows pressed state on history button when historyOpen=true', () => {
      renderToolbar({
        defaultExpanded: true,
        onHistoryToggle,
        historyOpen: true,
      })
      const textGroup = screen.getByText('Text').closest('fieldset')
      const historyButton = within(textGroup!).getAllByRole('button')[0]
      expect(historyButton).toHaveAttribute('aria-pressed', 'true')
    })
  })

  describe('readOnly mode', () => {
    it('does not render toolbar when readOnly=true', () => {
      renderToolbar({ readOnly: true })
      expect(screen.queryByTestId('toolbar-scroller')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Extra keys')).not.toBeInTheDocument()
    })
  })

  // jsdom drops mask-image from inline styles, so the mask itself is checked
  // by the E2E suite; here only that a scroller mounted again is listened to.
  describe('Scroll edge listener', () => {
    it('listens to the scroller again after IME mode remounts it', () => {
      const add = vi.spyOn(HTMLElement.prototype, 'addEventListener')
      const { rerender } = renderToolbar({ imeMode: false })
      const scrollCalls = () =>
        add.mock.calls.filter(([type]) => type === 'scroll').length
      const first = scrollCalls()
      rerender(
        <KeyboardToolbar onKey={onKey} onCtrlKey={onCtrlKey} imeMode={true} />,
      )
      rerender(
        <KeyboardToolbar onKey={onKey} onCtrlKey={onCtrlKey} imeMode={false} />,
      )
      expect(scrollCalls()).toBeGreaterThan(first)
      add.mockRestore()
    })

    it('keeps its listener across renders with new inline handlers', () => {
      const add = vi.spyOn(HTMLElement.prototype, 'addEventListener')
      const { rerender } = render(
        <KeyboardToolbar
          onKey={onKey}
          onCtrlKey={onCtrlKey}
          onHistoryToggle={() => {}}
        />,
      )
      const scrollCalls = () =>
        add.mock.calls.filter(([type]) => type === 'scroll').length
      const first = scrollCalls()
      rerender(
        <KeyboardToolbar
          onKey={onKey}
          onCtrlKey={onCtrlKey}
          onHistoryToggle={() => {}}
        />,
      )
      expect(scrollCalls()).toBe(first)
      add.mockRestore()
    })
  })

  describe('Shift and the expanded rows', () => {
    it('closing the expanded rows turns Shift off', () => {
      renderToolbar({ onShiftChange })
      const more = screen.getByRole('button', { name: 'Extra keys' })
      fireEvent.click(more)
      fireEvent.click(screen.getByText('Shift'))
      expect(onShiftChange).toHaveBeenLastCalledWith(true)
      fireEvent.click(more)
      expect(onShiftChange).toHaveBeenLastCalledWith(false)
      fireEvent.click(screen.getByText('Tab'))
      expect(onKey).toHaveBeenCalledWith('Tab')
      expect(onShiftKey).not.toHaveBeenCalled()
    })

    it('closing them without Shift on changes no modifier', () => {
      renderToolbar({ onShiftChange })
      const more = screen.getByRole('button', { name: 'Extra keys' })
      fireEvent.click(more)
      fireEvent.click(more)
      expect(onShiftChange).not.toHaveBeenCalled()
    })

    it('hides Shift+Tab without a Shift key handler', () => {
      render(
        <KeyboardToolbar onKey={onKey} onCtrlKey={onCtrlKey} defaultExpanded />,
      )
      expect(
        screen.queryByRole('button', { name: 'Shift+Tab' }),
      ).not.toBeInTheDocument()
    })
  })

  describe('Keyboard toggle', () => {
    it('calls onToggleKeyboard when keyboard button clicked', () => {
      renderToolbar({ onToggleKeyboard })
      const keyboardButton = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-key') === 'Keyboard')
      fireEvent.click(keyboardButton!)
      expect(onToggleKeyboard).toHaveBeenCalled()
    })
  })

  describe('Paste functionality', () => {
    it('calls onPaste when paste button clicked', () => {
      const mockPaste = vi.fn()
      renderToolbar({ defaultExpanded: true, onPaste: mockPaste })
      fireEvent.click(
        document.querySelector('[data-key="TmuxPaste"]') as HTMLElement,
      )
      expect(mockPaste).toHaveBeenCalled()
    })
  })

  describe('Select text and Attach image', () => {
    it('onSelectText called when Select text clicked', () => {
      const mockSelectText = vi.fn()
      renderToolbar({ defaultExpanded: true, onSelectText: mockSelectText })
      expect(screen.getByLabelText('Select text')).toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('Select text'))
      expect(mockSelectText).toHaveBeenCalled()
    })

    it('onAttachImage called when Attach image clicked', () => {
      const mockAttachImage = vi.fn()
      renderToolbar({ defaultExpanded: true, onAttachImage: mockAttachImage })
      expect(screen.getByLabelText('Attach image')).toBeInTheDocument()
      fireEvent.click(screen.getByLabelText('Attach image'))
      expect(mockAttachImage).toHaveBeenCalled()
    })

    it('Select text only appears once (in Text row, not duplicated)', () => {
      renderToolbar({ defaultExpanded: true, onSelectText })
      const selectTextButtons = screen.getAllByLabelText('Select text')
      expect(selectTextButtons).toHaveLength(1)
    })

    it('Attach image only appears once (in Text row, not duplicated)', () => {
      renderToolbar({ defaultExpanded: true, onAttachImage })
      const attachButtons = screen.getAllByLabelText('Attach image')
      expect(attachButtons).toHaveLength(1)
    })
  })

  describe('TmuxCopy handler', () => {
    it('onTmuxCopy called when tmux copy button clicked', () => {
      const mockTmuxCopy = vi.fn()
      renderToolbar({
        defaultExpanded: true,
        showTmuxCopy: true,
        onTmuxCopy: mockTmuxCopy,
      })
      const scrollGroup = screen.getByText(/^Scroll/).closest('fieldset')
      const buttons = within(scrollGroup!).getAllByRole('button')
      // First button should be tmux copy when showTmuxCopy=true
      fireEvent.click(buttons[0])
      expect(mockTmuxCopy).toHaveBeenCalled()
    })
  })

  describe('Ctrl+Shift combo handling', () => {
    it('sends Ctrl+Shift+key when both modifiers active', () => {
      const mockCtrlShiftKey = vi.fn()
      renderToolbar({
        ctrlActive: true,
        shiftActive: true,
        onCtrlShiftKey: mockCtrlShiftKey,
      })
      const tabButton = screen.getByText('Tab')
      fireEvent.click(tabButton)
      expect(mockCtrlShiftKey).toHaveBeenCalledWith('Tab')
      expect(onCtrlChange).toHaveBeenCalledWith(false)
      expect(onShiftChange).toHaveBeenCalledWith(false)
    })

    it('Ctrl+Shift combo overlay shows buttons', () => {
      renderToolbar({ ctrlActive: true, shiftActive: true })
      const overlay = screen.getByTestId('ctrl-shift-combos-overlay')
      const buttons = within(overlay).getAllByRole('button')
      expect(buttons.length).toBe(4)
    })

    it('clicking Ctrl+Shift combo button sends the combo', () => {
      const mockCtrlShiftKey = vi.fn()
      renderToolbar({
        ctrlActive: true,
        shiftActive: true,
        onCtrlShiftKey: mockCtrlShiftKey,
      })
      const overlay = screen.getByTestId('ctrl-shift-combos-overlay')
      const buttons = within(overlay).getAllByRole('button')
      fireEvent.click(buttons[0])
      expect(mockCtrlShiftKey).toHaveBeenCalledWith('c')
      expect(onCtrlChange).toHaveBeenCalledWith(false)
      expect(onShiftChange).toHaveBeenCalledWith(false)
    })
  })

  describe('Shift handling', () => {
    it('Shift button toggles shift mode', () => {
      renderToolbar({ defaultExpanded: true })
      const navGroup = screen.getByText('Navigate').closest('fieldset')
      const shiftButton = within(navGroup!).getByText('Shift')
      fireEvent.click(shiftButton)
      expect(onShiftChange).toHaveBeenCalledWith(true)
    })

    it('Shift shows pressed state when shiftActive=true', () => {
      renderToolbar({ defaultExpanded: true, shiftActive: true })
      const navGroup = screen.getByText('Navigate').closest('fieldset')
      const shiftButton = within(navGroup!).getByText('Shift')
      expect(shiftButton).toHaveAttribute('aria-pressed', 'true')
    })

    it('sends Shift+key when a key is pressed in shift mode', () => {
      renderToolbar({ defaultExpanded: true, shiftActive: true })
      const navGroup = screen.getByText('Navigate').closest('fieldset')
      const arrowLeftButton = within(navGroup!)
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-key') === 'ArrowLeft')
      fireEvent.click(arrowLeftButton!)
      expect(onShiftKey).toHaveBeenCalledWith('ArrowLeft')
      expect(onShiftChange).toHaveBeenCalledWith(false)
    })

    it('Escape clears shiftActive', () => {
      renderToolbar({ shiftActive: true })
      fireEvent.click(screen.getByText('Esc'))
      expect(onShiftChange).toHaveBeenCalledWith(false)
    })
  })

  describe('Mouse and touch event prevention', () => {
    it('mousedown on non-keyboard-toggle buttons is prevented', () => {
      renderToolbar()
      const escButton = screen.getByText('Esc')
      const event = new MouseEvent('mousedown', { bubbles: true })
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      escButton.dispatchEvent(event)
      expect(preventDefaultSpy).toHaveBeenCalled()
    })

    it('keyboard toggle allows focus (preventDefault not called)', () => {
      renderToolbar()
      const keyboardButton = screen
        .getAllByRole('button')
        .find((b) => b.getAttribute('data-key') === 'Keyboard')
      const event = new MouseEvent('mousedown', { bubbles: true })
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      keyboardButton!.dispatchEvent(event)
      expect(preventDefaultSpy).not.toHaveBeenCalled()
    })
  })

  describe('Keycap defaults and the IME focus', () => {
    it('prevents the context menu on a key', () => {
      renderToolbar()
      expect(fireEvent.contextMenu(screen.getByText('Tab'))).toBe(false)
    })

    it('the keyboard toggle lets mousedown through', () => {
      renderToolbar()
      const kbd = document.querySelector('[data-key="Keyboard"]') as HTMLElement
      expect(fireEvent.mouseDown(kbd)).toBe(true)
      // jsdom touch events are not cancelable, so only the call is checked
      expect(() => fireEvent.touchStart(kbd)).not.toThrow()
      expect(() => fireEvent.touchStart(screen.getByText('Tab'))).not.toThrow()
    })

    it('focuses the IME input 50ms after it opens', () => {
      vi.useFakeTimers()
      try {
        render(
          <KeyboardToolbar
            onKey={onKey}
            onCtrlKey={onCtrlKey}
            onSendText={onSendText}
          />,
        )
        fireEvent.click(
          document.querySelector('[data-key="ImeToggle"]') as HTMLElement,
        )
        act(() => {
          vi.advanceTimersByTime(50)
        })
        expect(document.activeElement).toBe(
          document.querySelector('input[placeholder]'),
        )
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
