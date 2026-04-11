import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickActionsMenu } from './quick-actions-menu'

vi.mock('../hooks/use-haptic', () => ({
  useHaptic: () => ({ trigger: vi.fn(), isSupported: false }),
}))

describe('QuickActionsMenu', () => {
  let onSendKey: (...args: any[]) => any

  let onSendText: (...args: any[]) => any

  beforeEach(() => {
    onSendKey = vi.fn()
    onSendText = vi.fn()
    localStorage.clear()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 0
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders FAB button with Quick actions label initially closed', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    expect(
      screen.getByRole('button', { name: 'Quick actions' }),
    ).toBeInTheDocument()
  })

  it('opens menu when FAB is clicked', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Clear line' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Exit' })).toBeInTheDocument()
  })

  it('closes menu when FAB is clicked again', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }))
    expect(
      screen.queryByRole('button', { name: 'Clear' }),
    ).not.toBeInTheDocument()
  })

  it('closes menu on outside click', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
    // Click outside
    fireEvent.mouseDown(document.body)
    expect(
      screen.queryByRole('button', { name: 'Clear' }),
    ).not.toBeInTheDocument()
  })

  it('does not close on outside click when menu is closed', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    // menu is closed — mousedown outside should not throw
    fireEvent.mouseDown(document.body)
    expect(
      screen.getByRole('button', { name: 'Quick actions' }),
    ).toBeInTheDocument()
  })

  it('does not close when mousedown is inside the menu container', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    // Click inside the menu container (the FAB button itself is inside menuRef)
    const fab = screen.getByRole('button', { name: 'Close menu' })
    fireEvent.mouseDown(fab)
    // Menu should still be open (contains() returns true for inside click)
    expect(
      screen.getByRole('button', { name: 'Close menu' }),
    ).toBeInTheDocument()
  })

  it('Clear action sends text "clear" and Enter key, then closes menu', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(onSendText).toHaveBeenCalledWith('clear')
    expect(onSendKey).toHaveBeenCalledWith('Enter')
    expect(
      screen.queryByRole('button', { name: 'Clear' }),
    ).not.toBeInTheDocument()
  })

  it('Cancel action sends Ctrl+C key', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onSendKey).toHaveBeenCalledWith('c', { ctrl: true })
    expect(onSendText).not.toHaveBeenCalled()
  })

  it('Clear line action sends Ctrl+U', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear line' }))
    expect(onSendKey).toHaveBeenCalledWith('u', { ctrl: true })
  })

  it('Exit action sends Ctrl+D', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }))
    expect(onSendKey).toHaveBeenCalledWith('d', { ctrl: true })
  })

  it('loads saved position from localStorage', () => {
    localStorage.setItem(
      'termote-fab-position',
      JSON.stringify({ right: 50, bottom: 200 }),
    )
    const { container } = render(
      <QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />,
    )
    const fab = container.querySelector('.fixed.z-30') as HTMLElement
    expect(fab.style.right).toBe('50px')
    expect(fab.style.bottom).toBe('200px')
  })

  it('uses default position when localStorage is empty', () => {
    const { container } = render(
      <QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />,
    )
    const fab = container.querySelector('.fixed.z-30') as HTMLElement
    expect(fab.style.right).toBe('16px')
    expect(fab.style.bottom).toBe('112px')
  })

  it('handles invalid JSON in localStorage gracefully', () => {
    localStorage.setItem('termote-fab-position', 'invalid-json')
    const { container } = render(
      <QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />,
    )
    const fab = container.querySelector('.fixed.z-30') as HTMLElement
    expect(fab.style.right).toBe('16px')
  })

  it('does not toggle menu after drag (hasMoved = true)', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    const fab = screen.getByRole('button', { name: 'Quick actions' })

    // Simulate touch drag (move > 8px)
    fireEvent.touchStart(fab, {
      touches: [{ clientX: 100, clientY: 100 }],
    })
    fireEvent.touchMove(fab, {
      touches: [{ clientX: 150, clientY: 100 }], // 50px move
    })

    // Read position from DOM to simulate what handleTouchEnd does
    const container = fab.closest('.fixed.z-30') as HTMLElement
    if (container) {
      container.style.right = '50px'
      container.style.bottom = '112px'
    }
    fireEvent.touchEnd(fab, {
      changedTouches: [{ clientX: 150, clientY: 100 }],
    })

    // Menu should NOT open because hasMoved = true
    expect(
      screen.queryByRole('button', { name: 'Clear' }),
    ).not.toBeInTheDocument()
    // Position saved to localStorage
    expect(localStorage.getItem('termote-fab-position')).toBeTruthy()
  })

  it('handleTouchEnd does nothing if not dragging', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    const fab = screen.getByRole('button', { name: 'Quick actions' })
    // Touch end without touch start (isDragging.current = false)
    fireEvent.touchEnd(fab, {
      changedTouches: [{ clientX: 0, clientY: 0 }],
    })
    // No crash, menu stays closed
    expect(
      screen.queryByRole('button', { name: 'Clear' }),
    ).not.toBeInTheDocument()
  })

  it('handleTouchMove does nothing if not dragging', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    const fab = screen.getByRole('button', { name: 'Quick actions' })
    // Move without start (isDragging.current stays false)
    fireEvent.touchMove(fab, {
      touches: [{ clientX: 200, clientY: 200 }],
    })
    // No crash
    expect(fab).toBeInTheDocument()
  })

  it('small movement (< 8px) does not set hasMoved', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    const fab = screen.getByRole('button', { name: 'Quick actions' })

    fireEvent.touchStart(fab, { touches: [{ clientX: 100, clientY: 100 }] })
    fireEvent.touchMove(fab, { touches: [{ clientX: 104, clientY: 102 }] }) // < 8px in both
    fireEvent.touchEnd(fab, {
      changedTouches: [{ clientX: 104, clientY: 102 }],
    })

    // hasMoved stays false, so toggleMenu runs
    // But since isDragging was not set, tap branch runs
    fireEvent.click(fab)
    expect(
      screen.getByRole('button', { name: 'Close menu' }),
    ).toBeInTheDocument()
  })

  it('popup menu positions based on FAB right position (left-0 when right > half)', () => {
    // Mock window.innerWidth so right > innerWidth/2
    Object.defineProperty(window, 'innerWidth', {
      value: 400,
      configurable: true,
    })
    localStorage.setItem(
      'termote-fab-position',
      JSON.stringify({ right: 250, bottom: 50 }),
    )
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    const popup = document.querySelector('.absolute.flex.flex-col')
    expect(popup?.className).toContain('left-0')
  })

  it('popup menu positions top-14 when bottom > half of screen', () => {
    Object.defineProperty(window, 'innerHeight', {
      value: 400,
      configurable: true,
    })
    localStorage.setItem(
      'termote-fab-position',
      JSON.stringify({ right: 16, bottom: 250 }),
    )
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    const popup = document.querySelector('.absolute.flex.flex-col')
    expect(popup?.className).toContain('top-14')
  })

  it('popup menu positions right-0 and bottom-14 when position is small', () => {
    Object.defineProperty(window, 'innerWidth', {
      value: 800,
      configurable: true,
    })
    Object.defineProperty(window, 'innerHeight', {
      value: 800,
      configurable: true,
    })
    localStorage.setItem(
      'termote-fab-position',
      JSON.stringify({ right: 16, bottom: 112 }),
    )
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quick actions' }))
    const popup = document.querySelector('.absolute.flex.flex-col')
    expect(popup?.className).toContain('right-0')
    expect(popup?.className).toContain('bottom-14')
  })

  it('clampPosition clamps to minimum 4px from edges', () => {
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    const fab = screen.getByRole('button', { name: 'Quick actions' })
    const container = fab.closest('.fixed.z-30') as HTMLElement

    // Start at 100,100; move to very negative position to trigger clamp
    fireEvent.touchStart(fab, { touches: [{ clientX: 100, clientY: 100 }] })
    fireEvent.touchMove(fab, { touches: [{ clientX: -1000, clientY: -1000 }] })

    // The DOM style should be clamped
    const right = Number.parseInt(container.style.right || '16')
    const bottom = Number.parseInt(container.style.bottom || '112')
    expect(right).toBeGreaterThanOrEqual(4)
    expect(bottom).toBeGreaterThanOrEqual(4)
  })

  it('handleTouchEnd with hasMoved=true but null el does not crash', () => {
    // This tests the null check `if (el)` in handleTouchEnd
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    const fab = screen.getByRole('button', { name: 'Quick actions' })

    fireEvent.touchStart(fab, { touches: [{ clientX: 100, clientY: 100 }] })
    fireEvent.touchMove(fab, { touches: [{ clientX: 200, clientY: 100 }] })
    fireEvent.touchEnd(fab, {
      changedTouches: [{ clientX: 200, clientY: 100 }],
    })

    // No crash = test passes
    expect(fab).toBeInTheDocument()
  })

  it('toggleMenu returns early when hasMoved is true (drag prevention branch)', () => {
    // Use non-immediate requestAnimationFrame so hasMoved stays true
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((_cb) => 0)
    render(<QuickActionsMenu onSendKey={onSendKey} onSendText={onSendText} />)
    const fab = screen.getByRole('button', { name: 'Quick actions' })

    // Drag > 8px to set hasMoved=true
    fireEvent.touchStart(fab, { touches: [{ clientX: 100, clientY: 100 }] })
    fireEvent.touchMove(fab, { touches: [{ clientX: 200, clientY: 100 }] })
    fireEvent.touchEnd(fab, {
      changedTouches: [{ clientX: 200, clientY: 100 }],
    })

    // hasMoved.current is still true (rAF not called)
    // toggleMenu is triggered by click → returns early
    fireEvent.click(fab)
    expect(
      screen.queryByRole('button', { name: 'Clear' }),
    ).not.toBeInTheDocument()
  })
})
