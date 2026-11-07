import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import { SessionTabs } from './session-tabs'

const SESSIONS: Session[] = [
  { id: 'shell', name: 'Shell', icon: '💻', description: 'Terminal' },
  { id: 'code', name: 'Code', icon: '🤖', description: 'Code editor' },
]

const ONE_SESSION: Session[] = [
  { id: 'shell', name: 'Shell', icon: '💻', description: 'Terminal' },
]

describe('SessionTabs', () => {
  const defaultProps = {
    sessions: SESSIONS,
    activeId: 'shell',
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // scrollIntoView not available in jsdom
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('renders all session tabs', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByText('Shell')).toBeInTheDocument()
    expect(screen.getByText('Code')).toBeInTheDocument()
  })

  it('shows the hidden characters of a tab name', () => {
    render(
      <SessionTabs
        {...defaultProps}
        sessions={[{ ...SESSIONS[0], name: 'Sh\u202eell' }, SESSIONS[1]]}
      />,
    )
    expect(screen.getByText('Sh⟨U+202E⟩ell')).toBeInTheDocument()
    expect(screen.getByTitle('Sh⟨U+202E⟩ell - Terminal')).toBeInTheDocument()
    render(
      <SessionTabs
        {...defaultProps}
        sessions={[{ ...SESSIONS[1], name: 'Co\u202ede', description: '' }]}
      />,
    )
    expect(screen.getByTitle('Co⟨U+202E⟩de')).toBeInTheDocument()
  })

  it('renders add button', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByLabelText('Add session')).toBeInTheDocument()
  })

  it('calls onAdd when add button clicked', () => {
    render(<SessionTabs {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Add session'))
    expect(defaultProps.onAdd).toHaveBeenCalledTimes(1)
  })

  it('calls onSelect with session id when tab clicked', () => {
    render(<SessionTabs {...defaultProps} />)
    fireEvent.click(screen.getByText('Code'))
    expect(defaultProps.onSelect).toHaveBeenCalledWith('code')
  })

  it('marks the active tab selected and styles it', () => {
    render(<SessionTabs {...defaultProps} />)
    const shell = screen.getByRole('tab', { name: /Shell/ })
    const code = screen.getByRole('tab', { name: /Code/ })
    expect(shell).toHaveAttribute('aria-selected', 'true')
    expect(shell).toHaveAttribute('tabindex', '0')
    expect(code).toHaveAttribute('aria-selected', 'false')
    expect(code).toHaveAttribute('tabindex', '-1')
    expect(shell.parentElement).toHaveClass('shadow-sm')
    expect(code.parentElement).not.toHaveClass('shadow-sm')
  })

  it('grows the tabs to touch size on a touch screen', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(
      screen.getByRole('tab', { name: /Shell/ }).parentElement,
    ).toHaveClass('h-9', 'pointer-coarse:h-11')
    expect(screen.getByRole('tab', { name: /Code/ }).parentElement).toHaveClass(
      'h-8',
      'pointer-coarse:h-10',
    )
  })

  it('never nests the close button in the tab', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(
      screen.getByRole('tablist', { name: 'Sessions' }),
    ).toBeInTheDocument()
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.querySelector('button')).toBeNull()
    }
    expect(
      screen
        .getByRole('tablist')
        .contains(screen.getByLabelText('Add session')),
    ).toBe(false)
  })

  it('arrow keys, Home and End move focus between tabs without switching', () => {
    render(<SessionTabs {...defaultProps} />)
    const [shell, code] = screen.getAllByRole('tab')
    shell.focus()
    fireEvent.keyDown(shell, { key: 'ArrowRight' })
    expect(code).toHaveFocus()
    fireEvent.keyDown(code, { key: 'ArrowRight' })
    expect(shell).toHaveFocus()
    fireEvent.keyDown(shell, { key: 'ArrowLeft' })
    expect(code).toHaveFocus()
    fireEvent.keyDown(code, { key: 'ArrowLeft' })
    expect(shell).toHaveFocus()
    fireEvent.keyDown(shell, { key: 'End' })
    expect(code).toHaveFocus()
    fireEvent.keyDown(code, { key: 'Home' })
    expect(shell).toHaveFocus()
    fireEvent.keyDown(shell, { key: 'a' })
    expect(shell).toHaveFocus()
    expect(defaultProps.onSelect).not.toHaveBeenCalled()
  })

  it('ignores keys when no tab has focus', () => {
    render(<SessionTabs {...defaultProps} />)
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
    expect(document.body).toHaveFocus()
  })

  it('Delete closes the focused tab when tabs may be closed', () => {
    const { rerender } = render(<SessionTabs {...defaultProps} />)
    const code = screen.getByRole('tab', { name: /Code/ })
    code.focus()
    fireEvent.keyDown(code, { key: 'Delete' })
    expect(defaultProps.onRemove).toHaveBeenCalledWith('code')
    rerender(<SessionTabs {...defaultProps} canRemove={false} />)
    fireEvent.keyDown(screen.getByRole('tab', { name: /Code/ }), {
      key: 'Delete',
    })
    expect(defaultProps.onRemove).toHaveBeenCalledOnce()
  })

  it('shows the description in the tab title', () => {
    render(
      <SessionTabs
        {...defaultProps}
        sessions={[SESSIONS[0], { ...SESSIONS[1], description: '' }]}
      />,
    )
    expect(screen.getByRole('tab', { name: /Shell/ })).toHaveAttribute(
      'title',
      'Shell - Terminal',
    )
    expect(screen.getByRole('tab', { name: /Code/ })).toHaveAttribute(
      'title',
      'Code',
    )
  })

  it('shows close button when more than one session', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByLabelText('Close Shell')).toBeInTheDocument()
    expect(screen.getByLabelText('Close Code')).toBeInTheDocument()
  })

  it('hides the close button of other tabs until hover, so it cannot be hit unseen', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByLabelText('Close Code')).toHaveClass('invisible')
    expect(screen.getByLabelText('Close Shell')).not.toHaveClass('invisible')
  })

  it('does not show close button with single session', () => {
    render(<SessionTabs {...defaultProps} sessions={ONE_SESSION} />)
    expect(screen.queryByLabelText('Close Shell')).not.toBeInTheDocument()
  })

  it('calls onRemove with session id when close button clicked', () => {
    render(<SessionTabs {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Close Code'))
    expect(defaultProps.onRemove).toHaveBeenCalledWith('code')
  })

  it('stopPropagation on close button prevents onSelect', () => {
    render(<SessionTabs {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Close Code'))
    expect(defaultProps.onSelect).not.toHaveBeenCalled()
  })

  it('scrolls active tab into view when not visible', () => {
    // Make getBoundingClientRect return values where active tab is out of container bounds
    const originalGetBCR = Element.prototype.getBoundingClientRect
    let callCount = 0
    Element.prototype.getBoundingClientRect = vi.fn(() => {
      callCount++
      // First call is for the active element rect, second for the container rect
      // Make element appear outside container (rect.left < containerRect.left)
      return callCount % 2 === 1
        ? ({
            left: 0,
            right: 50,
            top: 0,
            bottom: 40,
            width: 50,
            height: 40,
          } as DOMRect)
        : ({
            left: 100,
            right: 300,
            top: 0,
            bottom: 40,
            width: 200,
            height: 40,
          } as DOMRect)
    })

    const { rerender } = render(
      <SessionTabs {...defaultProps} activeId="shell" />,
    )
    rerender(<SessionTabs {...defaultProps} activeId="code" />)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()

    Element.prototype.getBoundingClientRect = originalGetBCR
  })

  it('turns the mouse wheel sideways over the tabs', () => {
    render(<SessionTabs {...defaultProps} />)
    const bar = screen.getByRole('tablist', { name: 'Sessions' })
    Object.defineProperty(bar, 'clientWidth', { value: 100 })
    Object.defineProperty(bar, 'scrollWidth', { value: 300 })
    fireEvent.wheel(bar, { deltaY: 40 })
    expect(bar.scrollLeft).toBe(40)
  })

  it('renders session icons', () => {
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByText('💻')).toBeInTheDocument()
    expect(screen.getByText('🤖')).toBeInTheDocument()
  })

  it('shows the agent badge of a tab', () => {
    render(
      <SessionTabs
        {...defaultProps}
        sessions={[{ ...SESSIONS[0], agentStatus: 'working' }, SESSIONS[1]]}
      />,
    )
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(screen.getByRole('img', { name: 'Agent working' })).toBeVisible()
  })

  it('canRemove overrides the per-bar tab count', () => {
    const { rerender } = render(
      <SessionTabs {...defaultProps} sessions={ONE_SESSION} canRemove />,
    )
    expect(screen.getByLabelText('Close Shell')).toBeInTheDocument()
    rerender(<SessionTabs {...defaultProps} canRemove={false} />)
    expect(screen.queryByLabelText('Close Shell')).toBeNull()
  })

  describe('dragging a tab', () => {
    const THREE: Session[] = [
      ...SESSIONS,
      { id: 'logs', name: 'Logs', icon: '📜', description: '' },
    ]
    // The box around a tab's button, the one that drags
    const tab = (name: string) =>
      screen.getByRole('tab', { name: new RegExp(name) })
        .parentElement as HTMLElement
    // jsdom lays nothing out: the strip spans 0-300 and each tab 100 px,
    // Shell, Code, Logs, moved by the tab's own slide
    const layOut = () => {
      const rect = (left: number, width: number) =>
        ({ left, right: left + width, width, top: 0, bottom: 36 }) as DOMRect
      vi.spyOn(
        screen.getByRole('tablist'),
        'getBoundingClientRect',
      ).mockReturnValue(rect(0, 300))
      ;['Shell', 'Code', 'Logs'].forEach((name, i) => {
        const el = tab(name)
        vi.spyOn(el, 'getBoundingClientRect').mockImplementation(() =>
          rect(i * 100 + (Number.parseFloat(el.style.translate) || 0), 100),
        )
      })
    }
    const press = (el: HTMLElement, clientX: number, init = {}) =>
      fireEvent.pointerDown(el, {
        button: 0,
        pointerType: 'mouse',
        clientX,
        ...init,
      })
    const moveTo = (clientX: number) =>
      fireEvent.pointerMove(window, { clientX })
    const release = () => fireEvent.pointerUp(window)
    afterEach(async () => {
      vi.restoreAllMocks()
      // A drag's swallowed click is let go after its task
      await new Promise((r) => setTimeout(r))
    })

    it('slides a tab along the strip only and drops it before or after a tab', () => {
      const onMove = vi.fn()
      const onSelect = vi.fn()
      render(
        <SessionTabs
          {...defaultProps}
          sessions={THREE}
          onMove={onMove}
          onSelect={onSelect}
        />,
      )
      layOut()
      expect(tab('Logs')).toHaveAttribute('data-movable', 'true')
      press(tab('Logs'), 250)
      // Past the strip's left end: the tab stops at it, and moves only
      // across, never down
      moveTo(-100)
      expect(tab('Logs')).toHaveAttribute('data-dragging', 'true')
      expect(tab('Logs').style.translate).toBe('-200px 0')
      // The left half of Shell: before it; the line shows there
      moveTo(30)
      expect(tab('Shell').querySelector('.left-0')).not.toBeNull()
      release()
      expect(onMove).toHaveBeenCalledWith('logs', 0)
      expect(tab('Logs')).not.toHaveAttribute('data-dragging')
      expect(tab('Logs').style.translate).toBe('')
      expect(tab('Shell').querySelector('.bg-accent')).toBeNull()
      // The click that ends the drag does not select the tab
      fireEvent.click(screen.getByRole('tab', { name: /Logs/ }))
      expect(onSelect).not.toHaveBeenCalled()
      // The right half of Code, past the strip's right end: after it
      press(tab('Shell'), 50)
      moveTo(170)
      expect(tab('Code').querySelector('.right-0')).not.toBeNull()
      moveTo(900)
      expect(tab('Shell').style.translate).toBe('200px 0')
      expect(tab('Logs').querySelector('.right-0')).not.toBeNull()
      moveTo(170)
      release()
      expect(onMove).toHaveBeenLastCalledWith('shell', 1)
    })

    it('a press that barely moves is a click', async () => {
      const onMove = vi.fn()
      const onSelect = vi.fn()
      render(
        <SessionTabs
          {...defaultProps}
          sessions={THREE}
          onMove={onMove}
          onSelect={onSelect}
        />,
      )
      layOut()
      press(tab('Code'), 150)
      moveTo(152)
      expect(tab('Code')).not.toHaveAttribute('data-dragging')
      release()
      fireEvent.click(screen.getByRole('tab', { name: /Code/ }))
      expect(onSelect).toHaveBeenCalledWith('code')
      expect(onMove).not.toHaveBeenCalled()
      // A drag's swallowed click goes away with its task: a later click
      // selects again
      press(tab('Code'), 150)
      moveTo(250)
      release()
      await new Promise((r) => setTimeout(r))
      fireEvent.click(screen.getByRole('tab', { name: /Shell/ }))
      expect(onSelect).toHaveBeenLastCalledWith('shell')
    })

    it('sends nothing over its own place, on Escape or a cancel', () => {
      const onMove = vi.fn()
      render(<SessionTabs {...defaultProps} sessions={THREE} onMove={onMove} />)
      layOut()
      // Over no other tab
      press(tab('Code'), 150)
      moveTo(160)
      release()
      // Escape puts it back; a key before the drag starts is left alone
      press(tab('Code'), 150)
      fireEvent.keyDown(window, { key: 'Escape' })
      moveTo(30)
      fireEvent.keyDown(window, { key: 'Enter' })
      expect(tab('Shell').querySelector('.left-0')).not.toBeNull()
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(tab('Code')).not.toHaveAttribute('data-dragging')
      expect(tab('Shell').querySelector('.bg-accent')).toBeNull()
      release()
      // The browser takes the pointer away
      press(tab('Code'), 150)
      moveTo(30)
      fireEvent.pointerCancel(window)
      release()
      expect(onMove).not.toHaveBeenCalled()
    })

    it('uses the tabs as they are when it lands', () => {
      const onMove = vi.fn()
      const { rerender } = render(
        <SessionTabs {...defaultProps} sessions={THREE} onMove={onMove} />,
      )
      layOut()
      press(tab('Logs'), 250)
      moveTo(30)
      // A move elsewhere put Code first meanwhile
      const moved = [THREE[1], THREE[0], THREE[2]]
      rerender(
        <SessionTabs {...defaultProps} sessions={moved} onMove={onMove} />,
      )
      release()
      // Before Shell, now second: the index in the new order
      expect(onMove).toHaveBeenCalledWith('logs', 1)
    })

    it('does not drag by touch, a right button or the close button', () => {
      const onMove = vi.fn()
      render(
        <SessionTabs
          {...defaultProps}
          sessions={THREE}
          onMove={onMove}
          canRemove
        />,
      )
      layOut()
      press(tab('Logs'), 250, { pointerType: 'touch' })
      moveTo(30)
      press(tab('Logs'), 250, { button: 2 })
      moveTo(30)
      press(screen.getByLabelText('Close Logs'), 250)
      moveTo(30)
      release()
      expect(tab('Logs')).not.toHaveAttribute('data-dragging')
      expect(onMove).not.toHaveBeenCalled()
    })

    it('a second press during a drag does not start another', () => {
      const onMove = vi.fn()
      render(<SessionTabs {...defaultProps} sessions={THREE} onMove={onMove} />)
      layOut()
      press(tab('Logs'), 250)
      press(tab('Shell'), 50)
      moveTo(30)
      release()
      expect(onMove).toHaveBeenCalledOnce()
      expect(onMove).toHaveBeenCalledWith('logs', 0)
    })

    it('stops listening when the tabs go away mid-drag', () => {
      const onMove = vi.fn()
      const { unmount } = render(
        <SessionTabs {...defaultProps} sessions={THREE} onMove={onMove} />,
      )
      layOut()
      press(tab('Logs'), 250)
      moveTo(30)
      unmount()
      moveTo(40)
      release()
      expect(onMove).not.toHaveBeenCalled()
    })

    it('does not drag without onMove, nor a single tab', () => {
      const { unmount } = render(<SessionTabs {...defaultProps} />)
      expect(tab('Shell')).not.toHaveAttribute('data-movable')
      unmount()
      render(
        <SessionTabs
          {...defaultProps}
          sessions={ONE_SESSION}
          onMove={vi.fn()}
        />,
      )
      expect(tab('Shell')).not.toHaveAttribute('data-movable')
    })
  })

  describe('as tabs come and go', () => {
    const tab = (name: string) =>
      screen.getByText(name).closest('.group') as HTMLElement
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('shrinks a tab a little while pressed', () => {
      render(<SessionTabs {...defaultProps} />)
      expect(tab('Shell')).toHaveClass('motion-safe:active:scale-[0.98]')
    })

    it('fades in only a tab added after the first ones', () => {
      const { rerender } = render(<SessionTabs {...defaultProps} />)
      expect(tab('Shell')).not.toHaveClass('motion-safe:starting:opacity-0')
      rerender(
        <SessionTabs
          {...defaultProps}
          sessions={[
            ...SESSIONS,
            { id: 'new', name: 'New', icon: '🆕', description: '' },
          ]}
        />,
      )
      expect(tab('New')).toHaveClass('motion-safe:starting:opacity-0')
      expect(tab('Code')).not.toHaveClass('motion-safe:starting:opacity-0')
    })

    it('fades a closed tab out, inert and out of the keys, then drops it', () => {
      // The tabs' transition, as the stylesheet gives it in a browser
      const real = window.getComputedStyle
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
        el.classList.contains('group')
          ? ({
              transitionDuration: '150ms',
              transitionDelay: '0s',
            } as CSSStyleDeclaration)
          : real(el),
      )
      const three = [
        ...SESSIONS,
        { id: 'more', name: 'More', icon: '➕', description: '' },
      ]
      const { rerender } = render(
        <SessionTabs {...defaultProps} sessions={three} onMove={vi.fn()} />,
      )
      rerender(
        <SessionTabs
          {...defaultProps}
          sessions={[three[0], three[2]]}
          activeId="code"
          onMove={vi.fn()}
        />,
      )
      const leaving = tab('Code')
      expect(leaving).toHaveAttribute('data-leaving', 'true')
      expect(leaving).toHaveAttribute('inert')
      expect(leaving).toHaveClass('pointer-events-none', 'opacity-0')
      expect(leaving).not.toHaveAttribute('data-movable')
      // Even the active id: a tab leaving is not the selected one
      expect(
        within(leaving).getByRole('tab', { hidden: true }),
      ).toHaveAttribute('aria-selected', 'false')
      // Arrow keys and Delete skip it
      screen.getByRole('tab', { name: /Shell/ }).focus()
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' })
      expect(document.activeElement).toHaveTextContent('More')
      fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Delete' })
      expect(defaultProps.onRemove).toHaveBeenCalledWith('more')
      act(() => {
        leaving.dispatchEvent(new Event('transitionend'))
      })
      expect(screen.queryByText('Code')).toBeNull()
    })
  })
})

describe('SessionTabs spare room', () => {
  let observed: (() => void)[] = []
  class FakeResizeObserver {
    constructor(cb: () => void) {
      observed.push(cb)
    }
    observe() {}
    disconnect() {}
  }
  const props = {
    sessions: SESSIONS,
    activeId: 'shell',
    onSelect: vi.fn(),
    onRemove: vi.fn(),
  }
  const resize = () => {
    for (const cb of observed) act(cb)
  }

  beforeEach(() => {
    observed = []
    Element.prototype.scrollIntoView = vi.fn()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reports the room after Add, and the overflow as negative', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const onSpareChange = vi.fn()
    render(
      <SessionTabs {...props} onAdd={vi.fn()} onSpareChange={onSpareChange} />,
    )
    // jsdom lays nothing out: no room, no overflow
    expect(onSpareChange).toHaveBeenLastCalledWith(0)
    const list = screen.getByRole('tablist')
    const row = list.parentElement!
    row.getBoundingClientRect = () => ({ right: 500 }) as DOMRect
    screen.getByRole('button', { name: 'Add session' }).getBoundingClientRect =
      () => ({ right: 380 }) as DOMRect
    resize()
    expect(onSpareChange).toHaveBeenLastCalledWith(120)
    Object.defineProperty(list, 'scrollWidth', { value: 700 })
    Object.defineProperty(list, 'clientWidth', { value: 400 })
    resize()
    expect(onSpareChange).toHaveBeenLastCalledWith(120 - 300)
    // The same room again: not reported twice
    onSpareChange.mockClear()
    resize()
    expect(onSpareChange).not.toHaveBeenCalled()
  })

  it('measures from the tab list when there is no Add button', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const onSpareChange = vi.fn()
    render(<SessionTabs {...props} onSpareChange={onSpareChange} />)
    const list = screen.getByRole('tablist')
    list.parentElement!.getBoundingClientRect = () =>
      ({ right: 300 }) as DOMRect
    list.getBoundingClientRect = () => ({ right: 260 }) as DOMRect
    resize()
    expect(onSpareChange).toHaveBeenLastCalledWith(40)
  })

  it('reports nothing without ResizeObserver or a listener', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const onSpareChange = vi.fn()
    render(<SessionTabs {...props} onSpareChange={onSpareChange} />)
    expect(onSpareChange).not.toHaveBeenCalled()
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    render(<SessionTabs {...props} />)
    resize()
  })
})
