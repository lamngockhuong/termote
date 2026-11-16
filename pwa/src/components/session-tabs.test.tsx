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

  it('lines an inactive tab label up with the active one', () => {
    // The active tab is 36 px tall with a 1 px top border, its label
    // centred 17.5 px above the bar's bottom; an inactive 32 px tab sits
    // 2 px up so its label (and its hover fill) is centred at 18 px
    render(<SessionTabs {...defaultProps} />)
    expect(screen.getByRole('tab', { name: /Code/ }).parentElement).toHaveClass(
      'mb-0.5',
    )
    expect(screen.getByRole('button', { name: 'Add session' })).toHaveClass(
      'mb-0.5',
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
    const slide = (name: string) => tab(name).style.translate
    // jsdom lays nothing out: the strip spans 0-300 and each tab 100 px,
    // Shell, Code, Logs (a slide is drawn over the layout, never in it)
    const layOut = (names = ['Shell', 'Code', 'Logs']) => {
      const rect = (left: number, width: number) =>
        ({ left, right: left + width, width, top: 0, bottom: 36 }) as DOMRect
      vi.spyOn(
        screen.getByRole('tablist'),
        'getBoundingClientRect',
      ).mockReturnValue(rect(0, 300))
      names.forEach((name, i) => {
        vi.spyOn(tab(name), 'getBoundingClientRect').mockReturnValue(
          rect(i * 100, 100),
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
      vi.useRealTimers()
      // A drag's swallowed click is let go after its task
      await new Promise((r) => setTimeout(r))
    })

    it('slides a tab along the strip only, the others making room', () => {
      const onMove = vi.fn()
      const onSelect = vi.fn()
      const props = {
        ...defaultProps,
        onMove,
        onSelect,
      }
      const { rerender } = render(<SessionTabs {...props} sessions={THREE} />)
      layOut()
      expect(tab('Logs')).toHaveAttribute('data-movable', 'true')
      screen.getByRole('tab', { name: /Logs/ }).focus()
      press(tab('Logs'), 250)
      // Past the strip's left end: the tab stops at it, and moves only
      // across, never down; its focus ring does not follow it
      moveTo(-100)
      expect(tab('Logs')).toHaveAttribute('data-dragging', 'true')
      expect(slide('Logs')).toBe('-200px 0')
      expect(document.activeElement).toBe(document.body)
      // Its middle past Shell's and Code's: both make room
      expect(slide('Shell')).toBe('100px 0')
      expect(slide('Code')).toBe('100px 0')
      // Back past Shell's middle only: Shell goes back
      moveTo(120)
      expect(slide('Shell')).toBe('')
      expect(slide('Code')).toBe('100px 0')
      moveTo(30)
      release()
      expect(onMove).toHaveBeenCalledWith('logs', 0)
      expect(tab('Logs')).not.toHaveAttribute('data-dragging')
      // It waits in its slot, the others aside, for the new order
      expect(slide('Logs')).toBe('-200px 0')
      expect(slide('Shell')).toBe('100px 0')
      // The click that ends the drag does not select the tab
      fireEvent.click(screen.getByRole('tab', { name: /Logs/ }))
      expect(onSelect).not.toHaveBeenCalled()
      // No other drag until then
      press(tab('Shell'), 50)
      moveTo(250)
      expect(tab('Shell')).not.toHaveAttribute('data-dragging')
      release()
      // The new order: drawn in place, no slide left
      const moved = [THREE[2], THREE[0], THREE[1]]
      rerender(<SessionTabs {...props} sessions={moved} />)
      expect(slide('Logs')).toBe('')
      expect(slide('Shell')).toBe('')
      expect(tab('Logs').style.transition).toBe('')
      // Rightwards, past the strip's end: after Logs, the last
      layOut(['Logs', 'Shell', 'Code'])
      press(tab('Logs'), 50)
      moveTo(900)
      expect(slide('Logs')).toBe('200px 0')
      expect(slide('Shell')).toBe('-100px 0')
      expect(slide('Code')).toBe('-100px 0')
      release()
      expect(onMove).toHaveBeenLastCalledWith('logs', 2)
      expect(slide('Logs')).toBe('200px 0')
    })

    it('lets the tabs slide back when the move ends without a new order', () => {
      vi.useFakeTimers()
      const onMove = vi.fn()
      const props = { ...defaultProps, sessions: THREE, onMove }
      const { rerender } = render(<SessionTabs {...props} />)
      layOut()
      press(tab('Logs'), 250)
      moveTo(30)
      release()
      rerender(<SessionTabs {...props} moving />)
      expect(slide('Logs')).toBe('-200px 0')
      rerender(<SessionTabs {...props} moving={false} />)
      expect(slide('Logs')).toBe('')
      expect(slide('Shell')).toBe('')
      // Nor a move nor an order ever comes: after a while
      press(tab('Logs'), 250)
      moveTo(30)
      release()
      act(() => {
        vi.advanceTimersByTime(4999)
      })
      expect(slide('Logs')).toBe('-200px 0')
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(slide('Logs')).toBe('')
      // No press while a move runs
      rerender(<SessionTabs {...props} moving />)
      press(tab('Logs'), 250)
      moveTo(30)
      expect(tab('Logs')).not.toHaveAttribute('data-dragging')
      release()
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
      moveTo(160)
      release()
      await new Promise((r) => setTimeout(r))
      fireEvent.click(screen.getByRole('tab', { name: /Shell/ }))
      expect(onSelect).toHaveBeenLastCalledWith('shell')
    })

    it('sends nothing in its own place, on Escape or a cancel', () => {
      const onMove = vi.fn()
      render(<SessionTabs {...defaultProps} sessions={THREE} onMove={onMove} />)
      layOut()
      // Not past a neighbour's middle
      press(tab('Code'), 150)
      moveTo(190)
      expect(slide('Logs')).toBe('')
      release()
      expect(slide('Code')).toBe('')
      // Escape puts it back; a key before the drag starts is left alone
      press(tab('Code'), 150)
      fireEvent.keyDown(window, { key: 'Escape' })
      moveTo(30)
      fireEvent.keyDown(window, { key: 'Enter' })
      expect(slide('Shell')).toBe('100px 0')
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(tab('Code')).not.toHaveAttribute('data-dragging')
      expect(slide('Code')).toBe('')
      expect(slide('Shell')).toBe('')
      release()
      // The browser takes the pointer away
      press(tab('Code'), 150)
      moveTo(30)
      fireEvent.pointerCancel(window)
      release()
      expect(onMove).not.toHaveBeenCalled()
    })

    it('sends nothing when the tabs changed under the drag', () => {
      const onMove = vi.fn()
      const { rerender } = render(
        <SessionTabs {...defaultProps} sessions={THREE} onMove={onMove} />,
      )
      layOut()
      press(tab('Logs'), 250)
      moveTo(30)
      // A tab closed elsewhere meanwhile
      rerender(
        <SessionTabs
          {...defaultProps}
          sessions={[THREE[0], THREE[2]]}
          onMove={onMove}
        />,
      )
      release()
      expect(onMove).not.toHaveBeenCalled()
      expect(slide('Logs')).toBe('')
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

    describe('in and out of tab groups', () => {
      // Shell, the group review's name, PR 1, PR 2, Logs: 100 px each
      const GROUPED: Session[] = [
        SESSIONS[0],
        { id: 'pr1', name: 'review/PR 1', icon: '', description: '' },
        { id: 'logs', name: 'Logs', icon: '', description: '' },
        { id: 'pr2', name: 'review/PR 2', icon: '', description: '' },
      ]
      const layOutGrouped = () => {
        const rect = (left: number, width: number) =>
          ({ left, right: left + width, width, top: 0, bottom: 36 }) as DOMRect
        vi.spyOn(
          screen.getByRole('tablist'),
          'getBoundingClientRect',
        ).mockReturnValue(rect(0, 500))
        const chip = screen.getByRole('button', { name: /^review,/ })
          .parentElement as HTMLElement
        ;[tab('Shell'), chip, tab('PR 1'), tab('PR 2'), tab('Logs')].forEach(
          (el, i) => {
            vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(
              rect(i * 100, 100),
            )
          },
        )
      }
      const renderGrouped = (over = {}) => {
        const props = {
          ...defaultProps,
          sessions: GROUPED,
          onMove: vi.fn(),
          onUpdate: vi.fn(async () => {}),
          tabGroups: true,
          ...over,
        }
        render(<SessionTabs {...props} />)
        layOutGrouped()
        return props
      }
      const drag = async (name: string, from: number, to: number) => {
        press(tab(name), from)
        moveTo(to)
        release()
        await act(async () => {})
      }

      it('joins the group it lands in, then moves', async () => {
        const props = renderGrouped()
        // Shell between PR 1 and PR 2
        await drag('Shell', 50, 250)
        expect(props.onUpdate).toHaveBeenCalledWith('shell', {
          name: 'review/Shell',
        })
        // Just before PR 2 among all of the tabs
        expect(props.onMove).toHaveBeenCalledWith('shell', 2)
        expect(props.onUpdate.mock.invocationCallOrder[0]).toBeLessThan(
          props.onMove.mock.invocationCallOrder[0],
        )
      })

      it('only renames a tab already in its place among all of the tabs', async () => {
        const props = renderGrouped()
        // Logs, between PR 1 and PR 2 among all of the tabs already
        await drag('Logs', 450, 350)
        expect(props.onUpdate).toHaveBeenCalledWith('logs', {
          name: 'review/Logs',
        })
        expect(props.onMove).not.toHaveBeenCalled()
      })

      it("joins a group right after its name, at its first tab's place", async () => {
        const props = renderGrouped()
        await drag('Logs', 450, 300)
        expect(props.onUpdate).toHaveBeenCalledWith('logs', {
          name: 'review/Logs',
        })
        expect(props.onMove).toHaveBeenCalledWith('logs', 1)
      })

      it('only renames a tab that keeps its place among the tabs', async () => {
        const props = renderGrouped()
        // Shell past the group's name, before PR 1
        await drag('Shell', 50, 150)
        expect(props.onUpdate).toHaveBeenCalledWith('shell', {
          name: 'review/Shell',
        })
        expect(props.onMove).not.toHaveBeenCalled()
      })

      it('leaves its group once none of its tabs is beside it', async () => {
        const props = renderGrouped()
        await drag('PR 1', 250, 50)
        expect(props.onUpdate).toHaveBeenCalledWith('pr1', { name: 'PR 1' })
        expect(props.onMove).toHaveBeenCalledWith('pr1', 0)
      })

      it('stays in its group moved among its tabs', async () => {
        const props = renderGrouped()
        await drag('PR 1', 250, 350)
        expect(props.onUpdate).not.toHaveBeenCalled()
        // After PR 2 among all of the tabs
        expect(props.onMove).toHaveBeenCalledWith('pr1', 3)
      })

      it('only moves where tabs are not renamed', async () => {
        const props = renderGrouped({ renameTab: false })
        // Inside the group: its name is kept, so nothing changes
        await drag('Logs', 450, 350)
        expect(props.onMove).not.toHaveBeenCalled()
        await drag('Logs', 450, 50)
        expect(props.onUpdate).not.toHaveBeenCalled()
        expect(props.onMove).toHaveBeenCalledWith('logs', 0)
      })

      it('only renames where tabs do not move', async () => {
        const props = renderGrouped({ onMove: undefined })
        await drag('Logs', 450, 350)
        expect(props.onUpdate).toHaveBeenCalledWith('logs', {
          name: 'review/Logs',
        })
        // Nowhere to land: back in its place
        await drag('Shell', 50, 60)
        expect(props.onUpdate).toHaveBeenCalledTimes(1)
        expect(slide('Shell')).toBe('')
      })
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

describe('SessionTabs tab groups', () => {
  const TABS: Session[] = [
    { id: 'pr1', name: 'review/PR 1', icon: '', description: '' },
    { id: 'shell', name: 'Shell', icon: '', description: '' },
    { id: 'api', name: 'coding/api', icon: '', description: '' },
    {
      id: 'pr2',
      name: 'review/PR 2',
      icon: '',
      description: '',
      agentStatus: 'blocked',
    },
  ]
  const props = () => ({
    sessions: TABS,
    activeId: 'shell',
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onUpdate: vi.fn(async () => {}),
    tabGroups: true,
    workspace: 'w',
  })
  // The bar left to right: a group's name as [name]
  const bar = () =>
    [
      ...screen
        .getByRole('tablist')
        .querySelectorAll<HTMLElement>('[role="tab"], [data-group-chip]'),
    ].map((el) =>
      el.dataset.groupChip === undefined
        ? el.querySelector('.truncate')!.textContent
        : `[${el.dataset.groupChip}]`,
    )
  const chip = (name: string) =>
    screen.getByRole('button', { name: new RegExp(`^${name},`) })

  beforeEach(() => {
    localStorage.clear()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it("gathers a group's tabs after its coloured name, each without the group's", () => {
    render(<SessionTabs {...props()} />)
    expect(bar()).toEqual([
      '[review]',
      'PR 1',
      'PR 2',
      'Shell',
      '[coding]',
      'api',
    ])
    expect(chip('review')).toHaveAccessibleName('review, tab group of 2 tabs')
    expect(chip('review')).toHaveAttribute('aria-expanded', 'true')
    expect(chip('review').className).toMatch(/bg-avatar-\d/)
    // Its tabs underlined in its colour; a tab in none is not
    expect(
      screen.getByRole('tab', { name: /PR 1/ }).parentElement!.className,
    ).toMatch(/after:bg-avatar-\d/)
    expect(
      screen.getByRole('tab', { name: /Shell/ }).parentElement!.className,
    ).not.toMatch(/after:bg-avatar/)
    // The whole name on hover
    expect(screen.getByRole('tab', { name: /PR 1/ })).toHaveAttribute(
      'title',
      'review/PR 1',
    )
  })

  it('shows the names whole without tab groups', () => {
    render(<SessionTabs {...props()} tabGroups={false} />)
    expect(bar()).toEqual(['review/PR 1', 'Shell', 'coding/api', 'review/PR 2'])
  })

  it('collapses and expands a group, which this browser keeps', () => {
    const { unmount } = render(<SessionTabs {...props()} />)
    fireEvent.click(chip('review'))
    expect(bar()).toEqual(['[review]', 'Shell', '[coding]', 'api'])
    expect(chip('review')).toHaveAttribute('aria-expanded', 'false')
    // Its count and the heaviest agent status of its tabs
    expect(chip('review')).toHaveTextContent('2')
    expect(within(chip('review')).getByRole('img')).toBeInTheDocument()
    unmount()
    render(<SessionTabs {...props()} />)
    expect(bar()).toEqual(['[review]', 'Shell', '[coding]', 'api'])
    fireEvent.click(chip('review'))
    expect(bar()).toHaveLength(6)
    expect(localStorage.getItem('termote-tab-groups-collapsed')).toBeNull()
  })

  it('keeps the tab on screen of a collapsed group', () => {
    render(<SessionTabs {...props()} activeId="pr2" />)
    fireEvent.click(chip('review'))
    expect(bar()).toEqual(['[review]', 'PR 2', 'Shell', '[coding]', 'api'])
  })

  it('collapses with nothing kept where there is no storage', () => {
    const set = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('full')
      })
    render(<SessionTabs {...props()} />)
    fireEvent.click(chip('review'))
    expect(bar()).toHaveLength(4)
    set.mockRestore()
  })

  describe("a group's menu", () => {
    const openMenu = (over = {}) => {
      const p = { ...props(), ...over }
      render(<SessionTabs {...p} />)
      fireEvent.contextMenu(chip('review'))
      return p
    }
    const items = () =>
      within(screen.getByRole('menu', { name: 'Tab group review' }))
        .getAllByRole('menuitem')
        .map((i) => i.textContent?.replace(/(F2|N)$/, ''))

    it('offers a new tab, a rename, collapse and ungroup', () => {
      openMenu()
      expect(items()).toEqual([
        'New tab in this group',
        'Rename tab group',
        'Collapse',
        'Ungroup',
      ])
    })

    it('offers only collapse to a view-only role', () => {
      openMenu({ onAdd: undefined, onUpdate: undefined })
      expect(items()).toEqual(['Collapse'])
      fireEvent.click(screen.getByRole('menuitem', { name: 'Collapse' }))
      expect(bar()).toHaveLength(4)
      fireEvent.contextMenu(chip('review'))
      expect(items()).toEqual(['Expand'])
    })

    it('adds a tab in the group', () => {
      const p = openMenu()
      fireEvent.click(
        screen.getByRole('menuitem', { name: /New tab in this group/ }),
      )
      const form = screen.getByRole('form', { name: 'New session' })
      expect(
        within(form).getByRole('combobox', { name: 'Tab group (optional)' }),
      ).toHaveValue('review')
      fireEvent.change(within(form).getByRole('textbox'), {
        target: { value: 'PR 3' },
      })
      fireEvent.submit(form)
      expect(p.onAdd).toHaveBeenCalledWith('review/PR 3', undefined)
    })

    it('renames every tab of the group, one after the other', async () => {
      const p = openMenu()
      fireEvent.click(
        screen.getByRole('menuitem', { name: /Rename tab group/ }),
      )
      const field = screen.getByRole('textbox', {
        name: 'New name for tab group review',
      })
      expect(field).toHaveValue('review')
      fireEvent.change(field, { target: { value: ' specs ' } })
      await act(async () => {
        fireEvent.keyDown(field, { key: 'Enter' })
      })
      expect(p.onUpdate.mock.calls).toEqual([
        ['pr1', { name: 'specs/PR 1' }],
        ['pr2', { name: 'specs/PR 2' }],
      ])
    })

    it('moves its collapsed state with a rename', async () => {
      render(<SessionTabs {...props()} />)
      fireEvent.click(chip('review'))
      fireEvent.contextMenu(chip('review'))
      fireEvent.click(
        screen.getByRole('menuitem', { name: /Rename tab group/ }),
      )
      const field = screen.getByRole('textbox')
      fireEvent.change(field, { target: { value: 'specs' } })
      await act(async () => {
        fireEvent.keyDown(field, { key: 'Enter' })
      })
      expect(
        JSON.parse(localStorage.getItem('termote-tab-groups-collapsed')!),
      ).toEqual(['w\nspecs'])
    })

    it('keeps the name on Escape, a blur, an empty or the same name', () => {
      const p = openMenu()
      const ask = () => {
        fireEvent.contextMenu(chip('review'))
        fireEvent.click(
          screen.getByRole('menuitem', { name: /Rename tab group/ }),
        )
        return screen.getByRole('textbox')
      }
      fireEvent.click(
        screen.getByRole('menuitem', { name: /Rename tab group/ }),
      )
      let field = screen.getByRole('textbox')
      fireEvent.keyDown(field, { key: 'Enter' })
      field = ask()
      fireEvent.change(field, { target: { value: ' ' } })
      fireEvent.keyDown(field, { key: 'Enter' })
      field = ask()
      fireEvent.change(field, { target: { value: 'specs' } })
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(chip('review')).toHaveFocus()
      field = ask()
      fireEvent.blur(field)
      expect(p.onUpdate).not.toHaveBeenCalled()
    })

    it('ungroups its tabs', async () => {
      const p = openMenu()
      await act(async () => {
        fireEvent.click(screen.getByRole('menuitem', { name: 'Ungroup' }))
      })
      expect(p.onUpdate.mock.calls).toEqual([
        ['pr1', { name: 'PR 1' }],
        ['pr2', { name: 'PR 2' }],
      ])
    })
  })

  it('fades in only a group made after the first ones', () => {
    const p = props()
    const { rerender } = render(<SessionTabs {...p} />)
    const box = (name: string) => chip(name).parentElement!
    expect(box('review')).not.toHaveClass('motion-safe:starting:opacity-0')
    rerender(
      <SessionTabs
        {...p}
        sessions={[
          ...TABS,
          { id: 'x', name: 'specs/auth', icon: '', description: '' },
        ]}
      />,
    )
    expect(box('specs')).toHaveClass('motion-safe:starting:opacity-0')
  })

  it('fades a group gone out, inert', () => {
    const real = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
      el.hasAttribute('data-leaving') || el.querySelector('[data-group-chip]')
        ? ({
            transitionDuration: '150ms',
            transitionDelay: '0s',
          } as CSSStyleDeclaration)
        : real(el),
    )
    const p = props()
    const { rerender } = render(<SessionTabs {...p} />)
    rerender(<SessionTabs {...p} sessions={TABS.slice(0, 2)} />)
    const gone = screen
      .getByRole('tablist')
      .querySelector('[data-group-chip="coding"]')!.parentElement!
    expect(gone).toHaveAttribute('data-leaving', 'true')
    expect(gone).toHaveAttribute('inert')
    // No menu on it
    fireEvent.contextMenu(gone)
    expect(screen.queryByRole('menu')).toBeNull()
    vi.restoreAllMocks()
  })

  it('starts a new tab in the group of the tab on screen, none for a tab not here', () => {
    const p = props()
    const { unmount } = render(<SessionTabs {...p} activeId="pr1" askName />)
    fireEvent.click(screen.getByRole('button', { name: 'Add session' }))
    expect(screen.getByRole('combobox')).toHaveValue('review')
    unmount()
    render(<SessionTabs {...p} activeId="elsewhere" askName />)
    fireEvent.click(screen.getByRole('button', { name: 'Add session' }))
    expect(screen.getByRole('combobox')).toHaveValue('')
  })

  it("keeps the rename of a group's name to its own keys", () => {
    const p = props()
    render(<SessionTabs {...p} />)
    chip('review').focus()
    fireEvent.keyDown(chip('review'), { key: 'F2' })
    const field = screen.getByRole('textbox')
    // No menu from the field, and typing, or an IME's Enter, ends nothing
    fireEvent.contextMenu(field)
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.keyDown(field, { key: 'a' })
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    expect(field).toBeInTheDocument()
    expect(p.onUpdate).not.toHaveBeenCalled()
  })

  describe('keys', () => {
    it("reach a group's name like a tab", () => {
      render(<SessionTabs {...props()} />)
      const shell = screen.getByRole('tab', { name: /Shell/ })
      shell.focus()
      fireEvent.keyDown(shell, { key: 'ArrowRight' })
      expect(chip('coding')).toHaveFocus()
      fireEvent.keyDown(chip('coding'), { key: 'ArrowRight' })
      expect(screen.getByRole('tab', { name: /api/ })).toHaveFocus()
      fireEvent.keyDown(document.activeElement!, { key: 'Home' })
      expect(chip('review')).toHaveFocus()
      fireEvent.keyDown(chip('review'), { key: 'ArrowLeft' })
      expect(screen.getByRole('tab', { name: /api/ })).toHaveFocus()
    })

    it("open a group's menu, its rename and a new tab in it", () => {
      render(<SessionTabs {...props()} />)
      const review = chip('review')
      expect(review).toHaveAttribute('aria-keyshortcuts', 'Shift+F10 F2 N')
      review.focus()
      fireEvent.keyDown(review, { key: 'F10', shiftKey: true })
      expect(
        screen.getByRole('menu', { name: 'Tab group review' }),
      ).toBeInTheDocument()
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      chip('review').focus()
      fireEvent.keyDown(chip('review'), { key: 'F2' })
      expect(
        screen.getByRole('textbox', { name: 'New name for tab group review' }),
      ).toHaveFocus()
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
      fireEvent.keyDown(chip('review'), { key: 'n', code: 'KeyN' })
      expect(
        screen.getByRole('combobox', { name: 'Tab group (optional)' }),
      ).toHaveValue('review')
      // Any other key does nothing to it
      fireEvent.keyDown(chip('review'), { key: 'Delete' })
    })

    it('offer only the menu where tabs are neither renamed nor added', () => {
      render(
        <SessionTabs {...props()} onAdd={undefined} onUpdate={undefined} />,
      )
      const review = chip('review')
      expect(review).toHaveAttribute('aria-keyshortcuts', 'Shift+F10')
      review.focus()
      fireEvent.keyDown(review, { key: 'F2' })
      fireEvent.keyDown(review, { key: 'n', code: 'KeyN' })
      expect(screen.queryByRole('textbox')).toBeNull()
    })
  })

  describe("a tab's menu", () => {
    const openMenu = (name: RegExp, over = {}) => {
      const p = { ...props(), ...over }
      render(<SessionTabs {...p} />)
      fireEvent.contextMenu(screen.getByRole('tab', { name }))
      return p
    }
    const group = () => screen.getByRole('group', { name: 'Add to tab group' })
    const names = () =>
      within(group())
        .getAllByRole('menuitem')
        .map((i) => i.textContent)

    it('adds the tab to another group, or takes it out of its own', () => {
      const p = openMenu(/PR 1/)
      expect(names()).toEqual([
        'coding',
        'New tab group…',
        'Remove from tab group',
      ])
      fireEvent.click(screen.getByRole('menuitem', { name: 'coding' }))
      expect(p.onUpdate).toHaveBeenCalledWith('pr1', { name: 'coding/PR 1' })
      fireEvent.contextMenu(screen.getByRole('tab', { name: /PR 1/ }))
      fireEvent.click(
        screen.getByRole('menuitem', { name: 'Remove from tab group' }),
      )
      expect(p.onUpdate).toHaveBeenLastCalledWith('pr1', { name: 'PR 1' })
    })

    it('offers a tab in none every group', () => {
      openMenu(/Shell/)
      expect(names()).toEqual(['review', 'coding', 'New tab group…'])
    })

    it('names a new group on the tab: Enter moves it, an empty name and Escape do not', () => {
      const p = openMenu(/PR 1/)
      const ask = () => {
        fireEvent.click(
          screen.getByRole('menuitem', { name: 'New tab group…' }),
        )
        return screen.getByRole('textbox', {
          name: 'New tab group for review/PR 1',
        })
      }
      let field = ask()
      expect(field).toHaveValue('')
      fireEvent.keyDown(field, { key: 'Enter' })
      fireEvent.contextMenu(screen.getByRole('tab', { name: /PR 1/ }))
      field = ask()
      fireEvent.change(field, { target: { value: 'specs' } })
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(p.onUpdate).not.toHaveBeenCalled()
      fireEvent.contextMenu(screen.getByRole('tab', { name: /PR 1/ }))
      field = ask()
      fireEvent.change(field, { target: { value: ' specs ' } })
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(p.onUpdate).toHaveBeenCalledWith('pr1', { name: 'specs/PR 1' })
    })

    it("renames a tab without its group's name", () => {
      const p = openMenu(/PR 1/)
      fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }))
      const field = screen.getByRole('textbox', {
        name: 'New name for review/PR 1',
      })
      expect(field).toHaveValue('PR 1')
      fireEvent.change(field, { target: { value: 'PR 9' } })
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(p.onUpdate).toHaveBeenCalledWith('pr1', { name: 'review/PR 9' })
    })

    it('has no group items where tabs cannot be renamed', () => {
      openMenu(/PR 1/, { renameTab: false })
      expect(screen.queryByRole('group')).toBeNull()
    })

    it('moves a tab among its group with the keys, never out of it', () => {
      const onMove = vi.fn()
      render(<SessionTabs {...props()} onMove={onMove} />)
      const pr1 = screen.getByRole('tab', { name: /PR 1/ })
      pr1.focus()
      fireEvent.keyDown(pr1, { key: 'ArrowRight', altKey: true })
      // After PR 2, the last of all of the tabs
      expect(onMove).toHaveBeenLastCalledWith('pr1', 3)
      const pr2 = screen.getByRole('tab', { name: /PR 2/ })
      pr2.focus()
      fireEvent.keyDown(pr2, { key: 'ArrowRight', altKey: true })
      expect(onMove).toHaveBeenCalledTimes(1)
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
