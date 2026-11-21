import { fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useSwipeToClose } from './use-swipe-to-close'

function Sheet({
  enabled = true,
  onClose,
}: {
  enabled?: boolean
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useSwipeToClose(ref, enabled, onClose)
  return (
    <div ref={ref} data-testid="sheet">
      <header data-testid="header">Title</header>
      <div data-testid="scroller">
        <p data-testid="row">Row</p>
        <input aria-label="Search" />
      </div>
    </div>
  )
}

function setup(enabled = true) {
  const onClose = vi.fn()
  render(<Sheet enabled={enabled} onClose={onClose} />)
  const sheet = screen.getByTestId('sheet')
  Object.defineProperty(sheet, 'offsetHeight', { value: 800 })
  return { onClose, sheet }
}

const at = (x: number, y: number) => [{ identifier: 1, clientX: x, clientY: y }]

// Presses at (100, 100), moves through each point, and lets go at the last
function swipe(
  target: Element,
  points: [number, number][],
  end: 'touchEnd' | 'touchCancel' = 'touchEnd',
) {
  fireEvent.touchStart(target, {
    touches: at(100, 100),
    changedTouches: at(100, 100),
  })
  for (const [x, y] of points) {
    fireEvent.touchMove(target, { touches: at(x, y), changedTouches: at(x, y) })
  }
  const [x, y] = points[points.length - 1]
  fireEvent[end](target, { touches: [], changedTouches: at(x, y) })
}

describe('useSwipeToClose', () => {
  it('follows the finger down and closes on a long pull', () => {
    const { onClose, sheet } = setup()
    const header = screen.getByTestId('header')
    fireEvent.touchStart(header, {
      touches: at(100, 100),
      changedTouches: at(100, 100),
    })
    fireEvent.touchMove(header, {
      touches: at(100, 110),
      changedTouches: at(100, 110),
    })
    fireEvent.touchMove(header, {
      touches: at(100, 170),
      changedTouches: at(100, 170),
    })
    // Measured from where the pull was recognised, not from the touch
    expect(sheet.style.translate).toBe('0 60px')
    expect(sheet.style.transition).toBe('none')
    fireEvent.touchMove(header, {
      touches: at(100, 260),
      changedTouches: at(100, 260),
    })
    fireEvent.touchEnd(header, { touches: [], changedTouches: at(100, 260) })
    expect(onClose).toHaveBeenCalledTimes(1)
    // Carries on down while it fades
    expect(sheet.style.translate).toBe('0 800px')
  })

  it('springs back from a short pull', () => {
    const { onClose, sheet } = setup()
    swipe(screen.getByTestId('header'), [
      [100, 110],
      [100, 130],
    ])
    expect(onClose).not.toHaveBeenCalled()
    expect(sheet.style.translate).toBe('')
    expect(sheet.style.transition).toBe('')
  })

  it('springs back when the touch is cancelled', () => {
    const { onClose, sheet } = setup()
    swipe(
      screen.getByTestId('row'),
      [
        [100, 110],
        [100, 400],
      ],
      'touchCancel',
    )
    expect(onClose).not.toHaveBeenCalled()
    expect(sheet.style.translate).toBe('')
  })

  it('pulls from the content only while it is at its top', () => {
    const { onClose } = setup()
    const scroller = screen.getByTestId('scroller')
    scroller.scrollTop = 40
    swipe(screen.getByTestId('row'), [
      [100, 110],
      [100, 400],
    ])
    expect(onClose).not.toHaveBeenCalled()
    scroller.scrollTop = 0
    swipe(screen.getByTestId('row'), [
      [100, 110],
      [100, 400],
    ])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves sideways and upward drags to the page', () => {
    const { onClose, sheet } = setup()
    const row = screen.getByTestId('row')
    swipe(row, [
      [130, 105],
      [100, 400],
    ])
    swipe(row, [
      [100, 90],
      [100, 400],
    ])
    expect(onClose).not.toHaveBeenCalled()
    expect(sheet.style.translate).toBe('')
  })

  it('does not pull from a text field or with two fingers', () => {
    const { onClose } = setup()
    swipe(screen.getByLabelText('Search'), [
      [100, 110],
      [100, 400],
    ])
    const header = screen.getByTestId('header')
    fireEvent.touchStart(header, {
      touches: [...at(100, 100), { identifier: 2, clientX: 200, clientY: 100 }],
      changedTouches: at(100, 100),
    })
    fireEvent.touchMove(header, {
      touches: at(100, 400),
      changedTouches: at(100, 400),
    })
    fireEvent.touchEnd(header, { touches: [], changedTouches: at(100, 400) })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('waits past a small wobble, and moves even when the page cannot be stopped', () => {
    const { sheet } = setup()
    const header = screen.getByTestId('header')
    fireEvent.touchStart(header, {
      touches: at(100, 100),
      changedTouches: at(100, 100),
    })
    fireEvent.touchMove(header, {
      touches: at(103, 104),
      changedTouches: at(103, 104),
    })
    expect(sheet.style.translate).toBe('')
    fireEvent.touchMove(header, {
      touches: at(100, 110),
      changedTouches: at(100, 110),
    })
    fireEvent.touchMove(header, {
      cancelable: false,
      touches: at(100, 150),
      changedTouches: at(100, 150),
    })
    expect(sheet.style.translate).toBe('0 40px')
  })

  it('springs back when a second finger lands mid-pull', () => {
    const { onClose, sheet } = setup()
    const header = screen.getByTestId('header')
    fireEvent.touchStart(header, {
      touches: at(100, 100),
      changedTouches: at(100, 100),
    })
    fireEvent.touchMove(header, {
      touches: at(100, 110),
      changedTouches: at(100, 110),
    })
    fireEvent.touchMove(header, {
      touches: at(100, 300),
      changedTouches: at(100, 300),
    })
    fireEvent.touchStart(header, {
      touches: [...at(100, 300), { identifier: 2, clientX: 200, clientY: 300 }],
      changedTouches: [{ identifier: 2, clientX: 200, clientY: 300 }],
    })
    expect(sheet.style.translate).toBe('')
    fireEvent.touchEnd(header, { touches: [], changedTouches: at(100, 300) })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does nothing when disabled', () => {
    const { onClose } = setup(false)
    swipe(screen.getByTestId('header'), [
      [100, 110],
      [100, 400],
    ])
    expect(onClose).not.toHaveBeenCalled()
  })
})
