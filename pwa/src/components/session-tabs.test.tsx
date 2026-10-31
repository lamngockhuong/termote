import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
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
    // The draggable box around a tab's button
    const tab = (name: string) =>
      screen.getByRole('tab', { name: new RegExp(name) })
        .parentElement as HTMLElement
    const dt = () => ({ setData: vi.fn(), effectAllowed: '', dropEffect: '' })
    // jsdom has no DragEvent, and a box has no width: clientX 0 is the left
    // half (before), anything more the right half (after)
    const dragAt = (
      type: 'dragOver' | 'drop',
      el: HTMLElement,
      clientX: number,
    ) => {
      const ev = createEvent[type](el, { dataTransfer: dt() })
      Object.defineProperty(ev, 'clientX', { value: clientX })
      fireEvent(el, ev)
    }

    it('drops a tab before or after the tab under the pointer', () => {
      const onMove = vi.fn()
      render(<SessionTabs {...defaultProps} sessions={THREE} onMove={onMove} />)
      expect(tab('Logs')).toHaveAttribute('draggable', 'true')
      const data = dt()
      fireEvent.dragStart(tab('Logs'), { dataTransfer: data })
      expect(data.setData).toHaveBeenCalledWith('text/x-termote-tab', 'logs')
      // The left half of Shell: before it; the line shows there
      dragAt('dragOver', tab('Shell'), 0)
      dragAt('dragOver', tab('Shell'), 0)
      expect(tab('Shell').querySelector('.left-0')).not.toBeNull()
      dragAt('drop', tab('Shell'), 0)
      expect(onMove).toHaveBeenCalledWith('logs', 0)
      expect(tab('Shell').querySelector('.bg-accent')).toBeNull()
      // The right half of Code: after it
      fireEvent.dragStart(tab('Shell'), { dataTransfer: dt() })
      dragAt('dragOver', tab('Code'), 5)
      expect(tab('Code').querySelector('.right-0')).not.toBeNull()
      dragAt('drop', tab('Code'), 5)
      expect(onMove).toHaveBeenLastCalledWith('shell', 1)
      // A drop on itself sends nothing; drag end clears the line
      fireEvent.dragStart(tab('Code'), { dataTransfer: dt() })
      dragAt('dragOver', tab('Code'), 0)
      dragAt('drop', tab('Code'), 0)
      fireEvent.dragEnd(tab('Code'))
      expect(onMove).toHaveBeenCalledTimes(2)
      expect(tab('Code').querySelector('.bg-accent')).toBeNull()
    })

    it('takes no drop without a drag from these tabs', () => {
      const onMove = vi.fn()
      render(<SessionTabs {...defaultProps} onMove={onMove} />)
      dragAt('dragOver', tab('Shell'), 0)
      dragAt('drop', tab('Shell'), 0)
      expect(onMove).not.toHaveBeenCalled()
      expect(tab('Shell').querySelector('.bg-accent')).toBeNull()
    })

    it('does not drag without onMove, nor a single tab', () => {
      const { unmount } = render(<SessionTabs {...defaultProps} />)
      expect(tab('Shell')).not.toHaveAttribute('draggable')
      unmount()
      render(
        <SessionTabs
          {...defaultProps}
          sessions={ONE_SESSION}
          onMove={vi.fn()}
        />,
      )
      expect(tab('Shell')).not.toHaveAttribute('draggable')
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
      expect(leaving).not.toHaveAttribute('draggable')
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
