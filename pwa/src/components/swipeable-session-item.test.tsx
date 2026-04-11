import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import { SwipeableSessionItem } from './swipeable-session-item'

const SESSION: Session = {
  id: '1',
  name: 'Shell',
  icon: '💻',
  description: 'Terminal',
}

// Use fireEvent directly with touch event options (jsdom-compatible, no Touch constructor)
function touchStart(el: Element, x: number, y: number) {
  fireEvent.touchStart(el, {
    touches: [{ clientX: x, clientY: y, identifier: 0, target: el }],
    changedTouches: [{ clientX: x, clientY: y, identifier: 0, target: el }],
  })
}

function touchMove(el: Element, x: number, y: number) {
  fireEvent.touchMove(el, {
    touches: [{ clientX: x, clientY: y, identifier: 0, target: el }],
    changedTouches: [{ clientX: x, clientY: y, identifier: 0, target: el }],
  })
}

function touchEnd(el: Element, x: number, y: number) {
  fireEvent.touchEnd(el, {
    touches: [],
    changedTouches: [{ clientX: x, clientY: y, identifier: 0, target: el }],
  })
}

describe('SwipeableSessionItem', () => {
  let onSelect: (...args: any[]) => any

  let onEdit: (...args: any[]) => any

  let onRemove: (...args: any[]) => any

  beforeEach(() => {
    onSelect = vi.fn()
    onEdit = vi.fn()
    onRemove = vi.fn()
    vi.useRealTimers()
  })

  function renderItem(
    props: Partial<Parameters<typeof SwipeableSessionItem>[0]> = {},
  ) {
    return render(
      <SwipeableSessionItem
        session={SESSION}
        isActive={false}
        onSelect={onSelect}
        onEdit={onEdit}
        onRemove={onRemove}
        canRemove={true}
        canEdit={true}
        {...props}
      />,
    )
  }

  function getContent() {
    return document.querySelector('.relative.z-10') as HTMLElement
  }

  it('renders session icon and name', () => {
    renderItem()
    expect(screen.getByText('💻')).toBeInTheDocument()
    expect(screen.getByText('Shell')).toBeInTheDocument()
  })

  it('renders edit and remove buttons when both canEdit and canRemove are true', () => {
    renderItem()
    expect(document.querySelectorAll('button').length).toBe(2)
  })

  it('does not render edit button when canEdit is false', () => {
    renderItem({ canEdit: false })
    expect(document.querySelectorAll('button').length).toBe(1)
  })

  it('does not render remove button when canRemove is false', () => {
    renderItem({ canRemove: false })
    expect(document.querySelectorAll('button').length).toBe(1)
  })

  it('renders no action buttons when both canEdit and canRemove are false', () => {
    renderItem({ canEdit: false, canRemove: false })
    expect(document.querySelectorAll('button').length).toBe(0)
  })

  it('applies active styling when isActive is true', () => {
    renderItem({ isActive: true })
    expect(getContent().className).toContain('border-blue-500')
  })

  it('does not apply active styling when isActive is false', () => {
    renderItem({ isActive: false })
    expect(getContent().className).not.toContain('border-blue-500')
  })

  // ── Tap = select ───────────────────────────────────────────────────────────

  it('calls onSelect on tap (deltaX < 10, offsetX = 0)', () => {
    renderItem()
    const content = getContent()
    touchStart(content, 100, 100)
    touchEnd(content, 102, 100)
    expect(onSelect).toHaveBeenCalled()
  })

  it('resets offset to 0 on tap when offset is non-zero (does not call onSelect)', () => {
    renderItem()
    const content = getContent()

    // First swipe left to set offset
    touchStart(content, 100, 100)
    touchMove(content, 60, 100)
    touchEnd(content, 60, 100)

    const offsetAfterSwipe = content.style.transform
    expect(offsetAfterSwipe).not.toContain('translateX(0px)')

    // Tap to close (offsetX != 0)
    touchStart(content, 100, 100)
    touchEnd(content, 102, 100)

    expect(content.style.transform).toContain('translateX(0px)')
    expect(onSelect).not.toHaveBeenCalled()
  })

  // ── Swipe left → delete revealed (threshold-based, slow velocity) ─────────

  it('swipe left past SWIPE_THRESHOLD snaps to maxLeft when velocity is low', () => {
    renderItem()
    const content = getContent()

    // Use slow velocity: deltaTime=10000ms so velocity ≈ 0
    let callCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() =>
      callCount++ === 0 ? 1000 : 11000,
    )

    touchStart(content, 100, 100)
    touchMove(content, 50, 100) // deltaX = -50, offsetX = -50 → isDragging = true
    touchEnd(content, 50, 100) // velocity=-50/10000 ≈ 0, offsetX=-50 < -25 → snap to maxLeft

    expect(content.style.transform).toContain('translateX(-70px)')
    vi.restoreAllMocks()
  })

  // ── Swipe right → edit revealed (threshold-based, slow velocity) ──────────

  it('swipe right past SWIPE_THRESHOLD snaps to maxRight when velocity is low', () => {
    renderItem()
    const content = getContent()

    let callCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() =>
      callCount++ === 0 ? 1000 : 11000,
    )

    touchStart(content, 100, 100)
    touchMove(content, 150, 100) // deltaX = +50
    touchEnd(content, 150, 100) // velocity≈0, offsetX=50 > 25 → snap to maxRight

    expect(content.style.transform).toContain('translateX(70px)')
    vi.restoreAllMocks()
  })

  // ── Velocity-based snap ────────────────────────────────────────────────────

  it('high velocity left swipe snaps to maxLeft regardless of small distance', () => {
    renderItem()
    const content = getContent()

    // Simulate fast swipe: small distance but high velocity
    // dateNow mock: start=1000, end=1010 → deltaTime=10ms, deltaX=-5px → velocity=-0.5
    let callCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() =>
      callCount++ === 0 ? 1000 : 1010,
    )

    touchStart(content, 100, 100)
    touchMove(content, 89, 100) // deltaX=-11 → isDragging
    touchEnd(content, 95, 100) // deltaX=-5, velocity=-0.5 < -0.3 → maxLeft

    expect(content.style.transform).toContain('translateX(-70px)')
    vi.restoreAllMocks()
  })

  it('high velocity right swipe snaps to maxRight regardless of small distance', () => {
    renderItem()
    const content = getContent()

    let callCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() =>
      callCount++ === 0 ? 1000 : 1010,
    )

    touchStart(content, 100, 100)
    touchMove(content, 111, 100) // deltaX=+11 → isDragging
    touchEnd(content, 105, 100) // deltaX=+5, velocity=0.5 > 0.3 → maxRight

    expect(content.style.transform).toContain('translateX(70px)')
    vi.restoreAllMocks()
  })

  // ── canRemove / canEdit guards ─────────────────────────────────────────────

  it('left swipe does not snap when canRemove is false (threshold path)', () => {
    renderItem({ canRemove: false })
    const content = getContent()

    let callCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() =>
      callCount++ === 0 ? 1000 : 11000,
    )

    touchStart(content, 100, 100)
    touchMove(content, 50, 100) // offsetX=-50 clamped to 0 (maxLeft=0)
    touchEnd(content, 50, 100) // velocity≈0, offsetX not < -25 (clamped to 0) → stay 0

    expect(content.style.transform).toContain('translateX(0px)')
    vi.restoreAllMocks()
  })

  it('right swipe does not snap when canEdit is false (threshold path)', () => {
    renderItem({ canEdit: false })
    const content = getContent()

    let callCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() =>
      callCount++ === 0 ? 1000 : 11000,
    )

    touchStart(content, 100, 100)
    touchMove(content, 150, 100) // offsetX=50 clamped to 0 (maxRight=0)
    touchEnd(content, 150, 100) // velocity≈0, offsetX not > 25 → stay 0

    expect(content.style.transform).toContain('translateX(0px)')
    vi.restoreAllMocks()
  })

  it('high velocity left snap does not trigger when canRemove is false', () => {
    renderItem({ canRemove: false })
    const content = getContent()

    let callCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() =>
      callCount++ === 0 ? 1000 : 1010,
    )

    touchStart(content, 100, 100)
    touchMove(content, 89, 100)
    touchEnd(content, 95, 100)

    expect(content.style.transform).toContain('translateX(0px)')
    vi.restoreAllMocks()
  })

  it('high velocity right snap does not trigger when canEdit is false', () => {
    renderItem({ canEdit: false })
    const content = getContent()

    let callCount = 0
    vi.spyOn(Date, 'now').mockImplementation(() =>
      callCount++ === 0 ? 1000 : 1010,
    )

    touchStart(content, 100, 100)
    touchMove(content, 111, 100)
    touchEnd(content, 105, 100)

    expect(content.style.transform).toContain('translateX(0px)')
    vi.restoreAllMocks()
  })

  // ── Vertical swipe ignored ─────────────────────────────────────────────────

  it('predominantly vertical move does not trigger horizontal drag', () => {
    renderItem()
    const content = getContent()

    touchStart(content, 100, 100)
    touchMove(content, 105, 200) // deltaX=5 (abs<=10, not yet dragging)
    touchMove(content, 106, 250) // deltaX=6 < abs(deltaY=150) → vertical, not dragging
    touchEnd(content, 106, 250) // deltaX=6 < 10 → tap → onSelect

    expect(onSelect).toHaveBeenCalled()
  })

  it('diagonal move with more vertical than horizontal does not start drag (line 60 false branch)', () => {
    renderItem()
    const content = getContent()

    // deltaX=15 > 10 (enters outer if), but deltaX=15 < deltaY=30 (false branch at line 60)
    touchStart(content, 100, 100)
    touchMove(content, 115, 130) // deltaX=15 > 10, deltaY=30 → vertical wins, no drag
    touchEnd(content, 115, 130)

    // isDraggingRef stays false → tap path runs → abs(deltaX)=15 > 10, so nothing happens
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('small movement below 10px threshold does not start dragging', () => {
    renderItem()
    const content = getContent()

    touchStart(content, 100, 100)
    touchMove(content, 104, 100) // deltaX=4 < 10, no drag
    touchEnd(content, 104, 100) // deltaX=4 < 10 → tap

    expect(onSelect).toHaveBeenCalled()
  })

  // ── Clamping ───────────────────────────────────────────────────────────────

  it('clamped offset does not exceed maxLeft * 1.2 (-84)', () => {
    renderItem()
    const content = getContent()

    touchStart(content, 100, 100)
    touchMove(content, -300, 100) // huge left

    const match = content.style.transform.match(
      /translateX\((-?\d+(?:\.\d+)?)px\)/,
    )
    if (match) {
      expect(Number.parseFloat(match[1])).toBeGreaterThanOrEqual(-84)
    }
  })

  it('clamped offset does not exceed maxRight * 1.2 (84)', () => {
    renderItem()
    const content = getContent()

    touchStart(content, 100, 100)
    touchMove(content, 500, 100) // huge right

    const match = content.style.transform.match(
      /translateX\((-?\d+(?:\.\d+)?)px\)/,
    )
    if (match) {
      expect(Number.parseFloat(match[1])).toBeLessThanOrEqual(84)
    }
  })

  // ── Edit / Remove button clicks ────────────────────────────────────────────

  it('clicking edit button calls onEdit after 100ms delay', () => {
    vi.useFakeTimers()
    renderItem()
    const [editBtn] = document.querySelectorAll('button')
    fireEvent.click(editBtn)
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(onEdit).toHaveBeenCalled()
  })

  it('clicking remove button calls onRemove after 100ms delay', () => {
    vi.useFakeTimers()
    renderItem()
    const btns = document.querySelectorAll('button')
    fireEvent.click(btns[1]) // second = remove
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(onRemove).toHaveBeenCalled()
  })

  it('handleEdit resets offset to 0 before calling onEdit', () => {
    vi.useFakeTimers()
    renderItem()
    const content = getContent()

    // Open right side
    touchStart(content, 100, 100)
    touchMove(content, 150, 100)
    touchEnd(content, 150, 100)
    expect(content.style.transform).toContain('translateX(70px)')

    fireEvent.click(document.querySelectorAll('button')[0])
    expect(content.style.transform).toContain('translateX(0px)')
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(onEdit).toHaveBeenCalled()
  })

  it('handleRemove resets offset to 0 before calling onRemove', () => {
    vi.useFakeTimers()
    renderItem()
    const content = getContent()

    // Open left side
    touchStart(content, 100, 100)
    touchMove(content, 50, 100)
    touchEnd(content, 50, 100)
    expect(content.style.transform).toContain('translateX(-70px)')

    fireEvent.click(document.querySelectorAll('button')[1])
    expect(content.style.transform).toContain('translateX(0px)')
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(onRemove).toHaveBeenCalled()
  })

  // ── Animation state ────────────────────────────────────────────────────────

  it('isAnimating is false during touchMove (no CSS transition)', () => {
    renderItem()
    const content = getContent()

    touchStart(content, 100, 100)
    touchMove(content, 150, 100)

    expect(content.style.transition).toBe('none')
  })

  it('isAnimating is true after touchEnd (CSS transition applied)', () => {
    renderItem()
    const content = getContent()

    touchStart(content, 100, 100)
    touchMove(content, 150, 100)
    touchEnd(content, 150, 100)

    expect(content.style.transition).toContain('transform 200ms')
  })

  // ── deltaX exactly at threshold boundary ──────────────────────────────────

  it('swipe below SWIPE_THRESHOLD with canRemove=false always snaps to center', () => {
    // With canRemove=false: maxLeft=0, so left swipe is clamped to 0 and finalOffset stays 0
    renderItem({ canRemove: false, canEdit: false })
    const content = getContent()

    touchStart(content, 100, 100)
    touchMove(content, 89, 100) // deltaX=-11 → isDragging=true
    touchMove(content, 80, 100) // deltaX=-20
    touchEnd(content, 80, 100) // maxLeft=0, no snap possible → finalOffset=0

    expect(content.style.transform).toContain('translateX(0px)')
  })

  // ── isDragging prevents select on large deltaX tap ─────────────────────────

  it('large deltaX (>=10) is not treated as tap', () => {
    renderItem()
    const content = getContent()

    touchStart(content, 100, 100)
    touchMove(content, 85, 100) // deltaX=-15, isDragging=true
    touchEnd(content, 90, 100) // deltaX=-10, isDragging branch, not tap

    expect(onSelect).not.toHaveBeenCalled()
  })
})
