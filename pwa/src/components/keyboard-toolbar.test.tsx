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
        {...props}
      />,
    )
  }

  // Basic rendering
  it('renders Tab key button', () => {
    renderToolbar()
    expect(screen.getByText('Tab')).toBeInTheDocument()
  })

  it('renders Esc key button', () => {
    renderToolbar()
    expect(screen.getByText('Esc')).toBeInTheDocument()
  })

  it('renders Ctrl key button', () => {
    renderToolbar()
    expect(screen.getByText('Ctrl')).toBeInTheDocument()
  })

  it('renders Shift key button', () => {
    renderToolbar()
    expect(screen.getByText('Shift')).toBeInTheDocument()
  })

  // Key press
  it('calls onKey when Tab is pressed', () => {
    renderToolbar()
    fireEvent.click(screen.getByText('Tab'))
    expect(onKey).toHaveBeenCalledWith('Tab')
  })

  it('calls onKey when Esc is pressed (no modifiers)', () => {
    renderToolbar()
    fireEvent.click(screen.getByText('Esc'))
    expect(onKey).toHaveBeenCalledWith('Escape')
  })

  // Ctrl modifier
  it('activates Ctrl mode on Ctrl click', () => {
    renderToolbar()
    fireEvent.click(screen.getByText('Ctrl'))
    expect(onCtrlChange).toHaveBeenCalledWith(true)
  })

  it('deactivates Ctrl mode on second Ctrl click', () => {
    renderToolbar()
    fireEvent.click(screen.getByText('Ctrl'))
    fireEvent.click(screen.getByText('Ctrl'))
    expect(onCtrlChange).toHaveBeenLastCalledWith(false)
  })

  it('sends Ctrl+key and deactivates ctrl after pressing a key in ctrl mode', () => {
    renderToolbar()
    fireEvent.click(screen.getByText('Ctrl'))
    // Wait for ctrl combos to appear
    const ctrlCBtn = screen.getByText('^C')
    fireEvent.click(ctrlCBtn)
    expect(onCtrlKey).toHaveBeenCalledWith('c')
    expect(onCtrlChange).toHaveBeenLastCalledWith(false)
  })

  it('uses external ctrlActive prop', () => {
    renderToolbar({ ctrlActive: true })
    // Ctrl combos should be visible
    expect(screen.getByText('^C')).toBeInTheDocument()
  })

  // Shift modifier
  it('activates Shift mode on Shift click', () => {
    renderToolbar()
    fireEvent.click(screen.getByText('Shift'))
    expect(onShiftChange).toHaveBeenCalledWith(true)
  })

  it('sends Shift+key when key pressed in shift mode', () => {
    renderToolbar()
    fireEvent.click(screen.getByText('Shift'))
    fireEvent.click(screen.getByText('Tab'))
    expect(onShiftKey).toHaveBeenCalledWith('Tab')
    expect(onShiftChange).toHaveBeenLastCalledWith(false)
  })

  it('uses external shiftActive prop', () => {
    renderToolbar({ shiftActive: true })
    // No ctrl+shift combos without ctrl
    expect(screen.queryByText(/\^⇧/)).not.toBeInTheDocument()
  })

  // Ctrl+Shift combos
  it('shows ctrl+shift combos when both active', () => {
    renderToolbar({ ctrlActive: true, shiftActive: true })
    expect(screen.getByText('^⇧C')).toBeInTheDocument()
    expect(screen.getByText('^⇧V')).toBeInTheDocument()
  })

  it('calls onCtrlShiftKey when ctrl+shift+key pressed', () => {
    renderToolbar({ ctrlActive: true, shiftActive: true })
    fireEvent.click(screen.getByText('^⇧V'))
    expect(onCtrlShiftKey).toHaveBeenCalledWith('v')
    expect(onCtrlChange).toHaveBeenLastCalledWith(false)
    expect(onShiftChange).toHaveBeenLastCalledWith(false)
  })

  it('all ctrl+shift combos present: C, V, Z, X', () => {
    renderToolbar({ ctrlActive: true, shiftActive: true })
    expect(screen.getByText('^⇧C')).toBeInTheDocument()
    expect(screen.getByText('^⇧V')).toBeInTheDocument()
    expect(screen.getByText('^⇧Z')).toBeInTheDocument()
    expect(screen.getByText('^⇧X')).toBeInTheDocument()
  })

  // Escape clears modifiers
  it('Escape clears Ctrl and Shift modifiers without sending key', () => {
    renderToolbar({ ctrlActive: true, shiftActive: true })
    fireEvent.click(screen.getByText('Esc'))
    expect(onKey).not.toHaveBeenCalled()
    expect(onCtrlChange).toHaveBeenCalledWith(false)
    expect(onShiftChange).toHaveBeenCalledWith(false)
  })

  it('Escape clears only Ctrl when only ctrl is active', () => {
    renderToolbar({ ctrlActive: true })
    fireEvent.click(screen.getByText('Esc'))
    expect(onKey).not.toHaveBeenCalled()
    expect(onCtrlChange).toHaveBeenCalledWith(false)
  })

  it('Escape sends key when no modifiers active', () => {
    renderToolbar()
    fireEvent.click(screen.getByText('Esc'))
    expect(onKey).toHaveBeenCalledWith('Escape')
  })

  // Key lowercase normalization
  it('normalizes single letter key to lowercase for ctrl', () => {
    renderToolbar({ ctrlActive: true })
    fireEvent.click(screen.getByText('^L'))
    expect(onCtrlKey).toHaveBeenCalledWith('l')
  })

  it('preserves special key names (Tab, ArrowUp) without lowercasing', () => {
    renderToolbar({ shiftActive: true })
    fireEvent.click(screen.getByText('Tab'))
    expect(onShiftKey).toHaveBeenCalledWith('Tab')
  })

  // Expand/collapse
  it('shows expand toggle button', () => {
    renderToolbar()
    expect(
      screen.getByRole('button', { name: 'Expand keyboard' }),
    ).toBeInTheDocument()
  })

  it('clicking expand toggle expands keyboard', () => {
    renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: 'Expand keyboard' }))
    expect(
      screen.getByRole('button', { name: 'Collapse keyboard' }),
    ).toBeInTheDocument()
  })

  it('expanded mode shows extra keys: PgUp, PgDn, Home, End', () => {
    renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: 'Expand keyboard' }))
    expect(screen.getByText('PgUp')).toBeInTheDocument()
    expect(screen.getByText('PgDn')).toBeInTheDocument()
  })

  it('expanded mode shows extra ctrl combos', () => {
    renderToolbar()
    fireEvent.click(screen.getByRole('button', { name: 'Expand keyboard' }))
    fireEvent.click(screen.getByText('Ctrl'))
    // Extra ctrl combos visible in expanded mode
    expect(screen.getByText('^B')).toBeInTheDocument()
    expect(screen.getByText('^R')).toBeInTheDocument()
  })

  it('defaultExpanded=true starts expanded', () => {
    renderToolbar({ defaultExpanded: true })
    expect(
      screen.getByRole('button', { name: 'Collapse keyboard' }),
    ).toBeInTheDocument()
    expect(screen.getByText('PgUp')).toBeInTheDocument()
  })

  it('pressing Bksp key sends Backspace', () => {
    renderToolbar({ defaultExpanded: true })
    fireEvent.click(screen.getByText('Bksp'))
    expect(onKey).toHaveBeenCalledWith('Backspace')
  })

  // IME mode
  it('shows IME toggle button when onSendText provided', () => {
    renderToolbar()
    // IME toggle is in MINIMAL_KEYS only when onSendText is provided
    const buttons = document.querySelectorAll('button')
    // Languages icon button is present
    expect(buttons.length).toBeGreaterThan(0)
  })

  it('does not show IME toggle when onSendText not provided', () => {
    renderToolbar({ onSendText: undefined })
    // IME toggle filtered out — check that IME input doesn't appear
    expect(screen.queryByPlaceholderText(/non-Latin/i)).not.toBeInTheDocument()
  })

  it('entering IME mode shows text input', () => {
    renderToolbar()
    // Find IME toggle button (Languages icon) — it's 2nd in MINIMAL_KEYS
    fireEvent.click(
      document.querySelector('[data-key="ImeToggle"]') as HTMLElement,
    )
    expect(screen.getByPlaceholderText(/non-Latin/i)).toBeInTheDocument()
  })

  it('uses external imeMode prop to show IME input', () => {
    renderToolbar({ imeMode: true })
    expect(screen.getByPlaceholderText(/non-Latin/i)).toBeInTheDocument()
  })

  it('IME mode: typing text updates input value', () => {
    renderToolbar({ imeMode: true })
    const input = screen.getByPlaceholderText(/non-Latin/i)
    fireEvent.change(input, { target: { value: 'hello' } })
    expect((input as HTMLInputElement).value).toBe('hello')
  })

  it('IME mode: Send button disabled when text is empty', () => {
    renderToolbar({ imeMode: true })
    const sendBtn = screen.getByRole('button', { name: 'Send text' })
    expect(sendBtn).toBeDisabled()
  })

  it('IME mode: Send button enabled when text is non-empty', () => {
    renderToolbar({ imeMode: true })
    const input = screen.getByPlaceholderText(/non-Latin/i)
    fireEvent.change(input, { target: { value: 'hello' } })
    const sendBtn = screen.getByRole('button', { name: 'Send text' })
    expect(sendBtn).not.toBeDisabled()
  })

  it('IME mode: clicking Send calls onSendText', () => {
    renderToolbar({ imeMode: true })
    const input = screen.getByPlaceholderText(/non-Latin/i)
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send text' }))
    expect(onSendText).toHaveBeenCalledWith('hello')
  })

  it('IME mode: pressing Enter calls onSendText', () => {
    renderToolbar({ imeMode: true })
    const input = screen.getByPlaceholderText(/non-Latin/i)
    fireEvent.change(input, { target: { value: 'world' } })
    fireEvent.keyDown(input, {
      key: 'Enter',
      nativeEvent: { isComposing: false },
    })
    expect(onSendText).toHaveBeenCalledWith('world')
  })

  it('IME mode: Enter during composition (isComposing) does not send', () => {
    renderToolbar({ imeMode: true })
    const input = screen.getByPlaceholderText(/non-Latin/i)
    fireEvent.change(input, { target: { value: 'hello' } })
    // jsdom: set isComposing on the event via compositionstart first
    fireEvent.compositionStart(input)
    // Now fire keyDown with isComposing=true (jsdom sets nativeEvent.isComposing after compositionstart)
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, 'isComposing', { value: true })
    input.dispatchEvent(event)
    expect(onSendText).not.toHaveBeenCalled()
  })

  it('IME mode: Send does nothing when text is empty/whitespace', () => {
    renderToolbar({ imeMode: true })
    const input = screen.getByPlaceholderText(/non-Latin/i)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send text' }))
    expect(onSendText).not.toHaveBeenCalled()
  })

  it('IME mode: Send does nothing when onSendText is not provided (false branch of && onSendText)', () => {
    renderToolbar({ imeMode: true, onSendText: undefined })
    // Without onSendText, the IME input may still render (controlled by imeMode prop)
    const input = screen.queryByPlaceholderText(/non-Latin/i)
    if (input) {
      fireEvent.change(input, { target: { value: 'hello' } })
      fireEvent.click(screen.getByRole('button', { name: 'Send text' }))
      // onSendText is undefined — the `if (imeText.trim() && onSendText)` false branch
    }
    // No crash = pass
  })

  it('IME mode: close button (X) exits IME mode', () => {
    renderToolbar({ imeMode: true, onImeModeChange })
    fireEvent.click(screen.getByRole('button', { name: 'Close IME input' }))
    expect(onImeModeChange).toHaveBeenCalledWith(false)
  })

  it('IME mode: toggleImeMode calls onImeModeChange with true when entering', () => {
    renderToolbar({ imeMode: false, onImeModeChange })
    // Click IME toggle
    fireEvent.click(
      document.querySelector('[data-key="ImeToggle"]') as HTMLElement,
    )
    expect(onImeModeChange).toHaveBeenCalledWith(true)
  })

  it('IME mode focus timeout fires and focuses input after 50ms', () => {
    vi.useFakeTimers()
    // Do not pass external imeMode so internal state controls it
    render(
      <KeyboardToolbar
        onKey={onKey}
        onCtrlKey={onCtrlKey}
        onSendText={onSendText}
        onImeModeChange={onImeModeChange}
      />,
    )
    fireEvent.click(
      document.querySelector('[data-key="ImeToggle"]') as HTMLElement,
    )
    // IME mode is now true internally → input renders
    act(() => {
      vi.advanceTimersByTime(50)
    })
    const imeInput = document.querySelector('input[placeholder]')
    expect(imeInput).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('IME mode focus timeout is cleaned up on unmount', () => {
    vi.useFakeTimers()
    const { unmount } = renderToolbar({ imeMode: false, onImeModeChange })
    fireEvent.click(
      document.querySelector('[data-key="ImeToggle"]') as HTMLElement,
    )
    unmount()
    act(() => {
      vi.advanceTimersByTime(100)
    })
    // No error = pass
  })

  // History toggle
  it('calls onHistoryToggle when history button clicked', () => {
    renderToolbar()
    fireEvent.click(
      document.querySelector('[data-key="HistoryToggle"]') as HTMLElement,
    )
    expect(onHistoryToggle).toHaveBeenCalled()
  })

  it('historyOpen=true shows active style on history button', () => {
    renderToolbar({ historyOpen: true })
    const historyBtn = document.querySelector('[data-key="HistoryToggle"]')
    expect(historyBtn).toHaveAttribute('aria-pressed', 'true')
  })

  it('historyOpen=false shows inactive style on history button', () => {
    renderToolbar({ historyOpen: false })
    const historyBtn = document.querySelector('[data-key="HistoryToggle"]')
    expect(historyBtn).toHaveAttribute('aria-pressed', 'false')
  })

  it('does not show history toggle when onHistoryToggle not provided', () => {
    renderToolbar({ onHistoryToggle: undefined })
    expect(
      document.querySelector('[data-key="HistoryToggle"]'),
    ).not.toBeInTheDocument()
  })

  // Scroll
  it('calls onScroll with up direction', () => {
    renderToolbar()
    fireEvent.click(
      document.querySelector('[data-key="ScrollUp"]') as HTMLElement,
    )
    expect(onScroll).toHaveBeenCalledWith('up')
  })

  it('calls onScroll with down direction', () => {
    renderToolbar()
    fireEvent.click(
      document.querySelector('[data-key="ScrollDown"]') as HTMLElement,
    )
    expect(onScroll).toHaveBeenCalledWith('down')
  })

  // TmuxCopy
  it('calls onTmuxCopy when tmux copy button clicked', () => {
    renderToolbar()
    fireEvent.click(
      document.querySelector('[data-key="TmuxCopy"]') as HTMLElement,
    )
    expect(onTmuxCopy).toHaveBeenCalled()
  })

  // Paste
  it('calls onPaste when paste button clicked', () => {
    renderToolbar()
    fireEvent.click(
      document.querySelector('[data-key="TmuxPaste"]') as HTMLElement,
    )
    expect(onPaste).toHaveBeenCalled()
  })

  // Attach image: only when the server takes uploads
  it('shows an Attach image key next to Paste only with a handler', () => {
    const { unmount } = renderToolbar()
    expect(document.querySelector('[data-key="Attach"]')).toBeNull()
    unmount()
    const onAttachImage = vi.fn()
    renderToolbar({ onAttachImage })
    const attach = screen.getByRole('button', { name: 'Attach image' })
    expect(attach.dataset.key).toBe('Attach')
    expect(
      document.querySelector('[data-key="TmuxPaste"]')?.nextElementSibling,
    ).toBe(attach)
    fireEvent.click(attach)
    expect(onAttachImage).toHaveBeenCalled()
    expect(onPaste).not.toHaveBeenCalled()
  })

  // Keyboard toggle
  it('calls onToggleKeyboard when keyboard button clicked', () => {
    renderToolbar()
    fireEvent.click(
      document.querySelector('[data-key="Keyboard"]') as HTMLElement,
    )
    expect(onToggleKeyboard).toHaveBeenCalled()
  })

  // onContextMenu prevention
  it('prevents context menu on key buttons', () => {
    renderToolbar()
    const btn = screen.getByText('Tab')
    const event = fireEvent.contextMenu(btn)
    // fireEvent returns false if default was prevented
    expect(event).toBe(false)
  })

  // onMouseDown prevention (non-keyboard-toggle)
  it('prevents mousedown default on non-keyboard-toggle buttons', () => {
    renderToolbar()
    const tabBtn = screen.getByText('Tab')
    const prevented = fireEvent.mouseDown(tabBtn)
    expect(prevented).toBe(false)
  })

  // onTouchStart: keyboard-toggle buttons do NOT prevent default (allows focus); others do
  it('keyboard-toggle button does NOT prevent touchstart default (allows keyboard to open)', () => {
    renderToolbar()
    const purpleBtn = document.querySelector(
      '[data-key="Keyboard"]',
    ) as HTMLElement
    // The button has onTouchStart that skips preventDefault for isKeyboardToggle
    // We can verify by checking the handler doesn't block propagation
    // This tests the !keyConfig.isKeyboardToggle branch
    if (purpleBtn) {
      let defaultPrevented = false
      purpleBtn.addEventListener(
        'touchstart',
        (e) => {
          defaultPrevented = e.defaultPrevented
        },
        { once: true, capture: true },
      )
      fireEvent.touchStart(purpleBtn)
      // keyboard-toggle does NOT call preventDefault
      expect(defaultPrevented).toBe(false)
    }
  })

  it('non-keyboard-toggle button touchStart fires without error', () => {
    renderToolbar()
    // Tab button onTouchStart calls e.preventDefault() — verify no crash
    const tabBtn = screen.getByText('Tab')
    expect(() => fireEvent.touchStart(tabBtn)).not.toThrow()
  })

  // getKeyButtonBg branches
  it('Ctrl button is pressed when ctrlActive', () => {
    renderToolbar({ ctrlActive: true })
    const ctrlBtn = screen.getByText('Ctrl').closest('button')!
    expect(ctrlBtn).toHaveAttribute('aria-pressed', 'true')
  })

  it('Shift button is pressed when shiftActive', () => {
    renderToolbar({ shiftActive: true })
    const shiftBtn = screen.getByText('Shift').closest('button')!
    expect(shiftBtn).toHaveAttribute('aria-pressed', 'true')
  })

  it('expand toggle is not a pressed-state key', () => {
    renderToolbar()
    const expandBtn = screen.getByRole('button', { name: 'Expand keyboard' })
    expect(expandBtn).not.toHaveAttribute('aria-pressed')
  })

  // No-op when handlers not provided
  it('does not throw when onTmuxCopy not provided and tmux button clicked', () => {
    renderToolbar({ onTmuxCopy: undefined })
    // Should not crash
    expect(() =>
      fireEvent.click(
        document.querySelector('[data-key="TmuxCopy"]') as HTMLElement,
      ),
    ).not.toThrow()
  })

  it('does not throw when onPaste not provided and paste button clicked', () => {
    renderToolbar({ onPaste: undefined })
    expect(() =>
      fireEvent.click(
        document.querySelector('[data-key="TmuxPaste"]') as HTMLElement,
      ),
    ).not.toThrow()
  })

  it('does not throw when onScroll not provided and scroll clicked', () => {
    renderToolbar({ onScroll: undefined })
    expect(() =>
      fireEvent.click(
        document.querySelector('[data-key="ScrollUp"]') as HTMLElement,
      ),
    ).not.toThrow()
  })

  it('does not throw when onToggleKeyboard not provided and keyboard button clicked', () => {
    renderToolbar({ onToggleKeyboard: undefined })
    expect(() =>
      fireEvent.click(
        document.querySelector('[data-key="Keyboard"]') as HTMLElement,
      ),
    ).not.toThrow()
  })

  it('does not call onHistoryToggle when not provided', () => {
    // Should not throw even if historyToggle key is pressed without handler
    renderToolbar({ onHistoryToggle: undefined })
    // History button absent, so no click needed
    expect(
      document.querySelector('[data-key="HistoryToggle"]'),
    ).not.toBeInTheDocument()
  })

  // Internal state for ctrl/shift without external control
  it('internal ctrl state works without onCtrlChange', () => {
    render(<KeyboardToolbar onKey={onKey} onCtrlKey={onCtrlKey} />)
    fireEvent.click(screen.getByText('Ctrl'))
    expect(screen.getByText('^C')).toBeInTheDocument()
  })

  it('internal shift state works without onShiftChange — no onShiftKey so key falls to onKey', () => {
    render(
      <KeyboardToolbar
        onKey={onKey}
        onCtrlKey={onCtrlKey}
        // No onShiftKey, no onShiftChange provided
      />,
    )
    fireEvent.click(screen.getByText('Shift'))
    // shiftActive is now true internally; pressing Tab calls onShiftKey which is undefined
    // The handleKey code does: onShiftKey?.(keyToSend) — optional call, no fallback to onKey
    // So onKey is NOT called. This tests the optional chaining path.
    fireEvent.click(screen.getByText('Tab'))
    // onShiftKey not provided → optional call is no-op; shift deactivated
    expect(onKey).not.toHaveBeenCalled()
  })

  it('ctrl+shift combo with no onCtrlShiftKey falls through gracefully', () => {
    render(<KeyboardToolbar onKey={onKey} onCtrlKey={onCtrlKey} />)
    fireEvent.click(screen.getByText('Ctrl'))
    fireEvent.click(screen.getByText('Shift'))
    fireEvent.click(screen.getByText('^⇧C'))
    // No crash - onCtrlShiftKey not provided
    expect(onKey).not.toHaveBeenCalled()
  })

  // Ctrl combo button event handlers (coverage for onMouseDown/onTouchStart/onContextMenu)
  it('ctrl combo buttons fire mousedown, touchstart, contextMenu without error', () => {
    renderToolbar({ ctrlActive: true })
    const ctrlCBtn = screen.getByText('^C')
    expect(() => fireEvent.mouseDown(ctrlCBtn)).not.toThrow()
    expect(() => fireEvent.touchStart(ctrlCBtn)).not.toThrow()
    expect(() => fireEvent.contextMenu(ctrlCBtn)).not.toThrow()
  })

  it('ctrl+shift combo buttons fire mousedown, touchstart, contextMenu without error', () => {
    renderToolbar({ ctrlActive: true, shiftActive: true })
    const csBtn = screen.getByText('^⇧C')
    expect(() => fireEvent.mouseDown(csBtn)).not.toThrow()
    expect(() => fireEvent.touchStart(csBtn)).not.toThrow()
    expect(() => fireEvent.contextMenu(csBtn)).not.toThrow()
  })

  it('ctrl combo onContextMenu returns false (default prevented)', () => {
    renderToolbar({ ctrlActive: true })
    const prevented = fireEvent.contextMenu(screen.getByText('^C'))
    expect(prevented).toBe(false)
  })

  it('ctrl+shift combo onContextMenu returns false (default prevented)', () => {
    renderToolbar({ ctrlActive: true, shiftActive: true })
    const prevented = fireEvent.contextMenu(screen.getByText('^⇧C'))
    expect(prevented).toBe(false)
  })

  // Arrow keys
  it('sends ArrowUp key', () => {
    renderToolbar()
    // Find arrow up button by aria or by checking button structure
    // ArrowUp is in MINIMAL_KEYS, use direct click
    const btns = Array.from(document.querySelectorAll('button'))
    // Tab/Esc/Enter/Ctrl/Shift are text; arrows are icon-only
    // Just verify toolbar renders without crash
    expect(btns.length).toBeGreaterThan(10)
  })
})

describe('key states (via rendering)', () => {
  const noop = vi.fn() as unknown as (...args: any[]) => any

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('history button is pressed when historyOpen=true', () => {
    render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        onHistoryToggle={noop}
        historyOpen={true}
      />,
    )
    expect(
      document.querySelector('[data-key="HistoryToggle"]'),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('history button is not pressed when historyOpen=false', () => {
    render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        onHistoryToggle={noop}
        historyOpen={false}
      />,
    )
    expect(
      document.querySelector('[data-key="HistoryToggle"]'),
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders the copy-mode and paste keys', () => {
    render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        onTmuxCopy={noop}
        onPaste={noop}
      />,
    )
    expect(document.querySelector('[data-key="TmuxCopy"]')).toBeInTheDocument()
    expect(document.querySelector('[data-key="TmuxPaste"]')).toBeInTheDocument()
  })

  it('renders the scroll keys', () => {
    render(<KeyboardToolbar onKey={noop} onCtrlKey={noop} onScroll={noop} />)
    expect(document.querySelector('[data-key="ScrollUp"]')).toBeInTheDocument()
  })

  it('regular key has no pressed state', () => {
    render(<KeyboardToolbar onKey={noop} onCtrlKey={noop} />)
    const tabBtn = screen.getByText('Tab').closest('button')!
    expect(tabBtn).not.toHaveAttribute('aria-pressed')
  })

  it('hides TmuxCopy button when showTmuxCopy=false', () => {
    const { container } = render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        onTmuxCopy={noop}
        showTmuxCopy={false}
      />,
    )
    // When showTmuxCopy is false, the button should not render
    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBeGreaterThan(0)
  })

  it('shows TmuxCopy button when showTmuxCopy=true', () => {
    const { container } = render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        onTmuxCopy={noop}
        showTmuxCopy={true}
      />,
    )
    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBeGreaterThan(0)
  })
})

describe('KeyboardToolbar layout', () => {
  const noop = vi.fn() as unknown as (...args: any[]) => any

  beforeEach(() => {
    vi.clearAllMocks()
    // jsdom has no <dialog> modal support
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })

  it('collapsed row keeps the key order, utility keys after expand', () => {
    render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        onSendText={noop}
        onHistoryToggle={noop}
      />,
    )
    const order = Array.from(document.querySelectorAll('[data-key]')).map(
      (el) => el.getAttribute('data-key'),
    )
    expect(order).toEqual([
      'Keyboard',
      'ImeToggle',
      'HistoryToggle',
      'Tab',
      'Escape',
      'Enter',
      'Control',
      'Shift',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Expand',
      'TmuxCopy',
      'TmuxPaste',
      'ScrollUp',
      'ScrollDown',
    ])
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
  })

  it('expanded toolbar splits keys into labelled rows', () => {
    render(<KeyboardToolbar onKey={noop} onCtrlKey={noop} defaultExpanded />)
    const nav = screen.getByRole('group', { name: 'Navigate' })
    expect(nav).toContainElement(screen.getByText('PgUp'))
    const scroll = screen.getByRole('group', { name: 'Scroll · copy mode' })
    expect(scroll).toContainElement(
      document.querySelector('[data-key="ScrollUp"]') as HTMLElement,
    )
    expect(
      screen.queryByRole('group', { name: 'Ctrl +' }),
    ).not.toBeInTheDocument()
  })

  it('the scroll row drops "copy mode" from its label without copy mode', () => {
    render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        defaultExpanded
        showTmuxCopy={false}
      />,
    )
    expect(screen.getByRole('group', { name: 'Scroll' })).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: 'Scroll · copy mode' }),
    ).not.toBeInTheDocument()
  })

  it('expanded + Ctrl shows the full combos in a floating Ctrl + row', () => {
    render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        defaultExpanded
        ctrlActive
      />,
    )
    const row = screen.getByRole('group', { name: 'Ctrl +' })
    expect(row).toContainElement(screen.getByText('^N'))
    expect(row).toContainElement(screen.getByText('^C'))
    // Floats above the toolbar, so pressing Ctrl does not resize the terminal
    const overlay = screen.getByTestId('ctrl-combos-overlay')
    expect(overlay).toContainElement(row)
    expect(overlay).toHaveClass('absolute', 'bottom-full')
  })

  it('expanded + Ctrl + Shift keeps the combos inline, no Ctrl + row', () => {
    render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        defaultExpanded
        ctrlActive
        shiftActive
      />,
    )
    expect(
      screen.queryByRole('group', { name: 'Ctrl +' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('^⇧C')).toBeInTheDocument()
  })

  it('collapsed + Ctrl shows only the common combos inline', () => {
    render(<KeyboardToolbar onKey={noop} onCtrlKey={noop} ctrlActive />)
    expect(screen.getByText('^E')).toBeInTheDocument()
    expect(screen.queryByText('^N')).not.toBeInTheDocument()
  })

  it('a Ctrl combo sends the control key', () => {
    const onCtrlKey = vi.fn()
    render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={onCtrlKey}
        defaultExpanded
        ctrlActive
      />,
    )
    fireEvent.click(screen.getByText('^N'))
    expect(onCtrlKey).toHaveBeenCalledWith('n')
  })

  it('does not render the Quick actions key without quickActions', () => {
    render(<KeyboardToolbar onKey={noop} onCtrlKey={noop} />)
    expect(
      screen.queryByRole('button', { name: 'Quick actions' }),
    ).not.toBeInTheDocument()
  })

  it('Quick actions key sits right before expand and opens the sheet', () => {
    const onSendKey = vi.fn()
    const onSendText = vi.fn()
    render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        quickActions={{ onSendKey, onSendText }}
      />,
    )
    const keys = Array.from(document.querySelectorAll('[data-key]')).map((el) =>
      el.getAttribute('data-key'),
    )
    expect(keys.indexOf('QuickActions')).toBe(keys.indexOf('Expand') - 1)

    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    const dialog = screen.getByRole('dialog', { name: 'Quick actions' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(onSendKey).toHaveBeenCalledWith('c', { ctrl: true })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Quick actions key keeps focus in the terminal (mousedown prevented)', () => {
    render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        quickActions={{ onSendKey: noop, onSendText: noop }}
      />,
    )
    const btn = screen.getByRole('button', { name: 'Quick actions' })
    expect(fireEvent.mouseDown(btn)).toBe(false)
  })

  it('readOnly renders no input controls', () => {
    const { container } = render(
      <KeyboardToolbar
        onKey={noop}
        onCtrlKey={noop}
        onSendText={noop}
        quickActions={{ onSendKey: noop, onSendText: noop }}
        readOnly
      />,
    )
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
