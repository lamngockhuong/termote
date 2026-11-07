import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import { MAIN_MIN } from '../utils/side-panel-width'
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_STEP,
} from '../utils/sidebar-width'
import { SessionSidebar } from './session-sidebar'

const SESSIONS: Session[] = [
  { id: '1', name: 'Shell', icon: '💻', description: '' },
  { id: '2', name: 'Dev', icon: '🔧', description: '' },
]

// The parent keeps the width, as App does in its settings
function Harness({
  initial,
  collapsed = false,
  onSave,
  onResizing,
}: {
  initial?: unknown
  collapsed?: boolean
  onSave: (width: number) => void
  onResizing: (resizing: boolean) => void
}) {
  const [width, setWidth] = useState<unknown>(initial)
  return (
    <SessionSidebar
      sessions={SESSIONS}
      activeId="1"
      onSelect={() => {}}
      isCollapsed={collapsed}
      width={width}
      onWidthChange={(w) => {
        setWidth(w)
        onSave(w)
      }}
      onResizingChange={onResizing}
    />
  )
}

function setup(props: { initial?: unknown; collapsed?: boolean } = {}) {
  const onSave = vi.fn()
  const onResizing = vi.fn()
  const view = render(
    <Harness {...props} onSave={onSave} onResizing={onResizing} />,
  )
  return { ...view, onSave, onResizing }
}

const handle = () =>
  screen.getByRole('separator', { name: 'Resize the sidebar' })
const aside = () => document.querySelector('aside')!
const px = (n: number) => `${n}px`

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SessionSidebar — width', () => {
  it('starts at the default, the handle saying its limits', () => {
    setup()
    expect(aside().style.width).toBe(px(SIDEBAR_DEFAULT))
    expect(handle()).toHaveAttribute('aria-valuenow', String(SIDEBAR_DEFAULT))
    expect(handle()).toHaveAttribute('aria-valuemin', String(SIDEBAR_MIN))
    expect(handle()).toHaveAttribute('aria-valuemax', String(SIDEBAR_MAX))
    expect(handle()).toHaveAttribute('aria-orientation', 'vertical')
  })

  it('shows a saved width, and the default for one it cannot use', () => {
    const { unmount } = setup({ initial: 400 })
    expect(aside().style.width).toBe('400px')
    unmount()
    setup({ initial: 'wide' })
    expect(aside().style.width).toBe(px(SIDEBAR_DEFAULT))
  })

  it('has no handle without a way to save the width, or collapsed', () => {
    const { unmount } = render(
      <SessionSidebar sessions={SESSIONS} activeId="1" onSelect={() => {}} />,
    )
    expect(screen.queryByRole('separator')).toBeNull()
    expect(aside().style.width).toBe(px(SIDEBAR_DEFAULT))
    unmount()
    setup({ collapsed: true })
    expect(screen.queryByRole('separator')).toBeNull()
    expect(aside().style.width).toBe('')
  })

  it('resizes from the keyboard, saved at once', () => {
    const { onSave } = setup()
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(aside().style.width).toBe(px(SIDEBAR_DEFAULT + SIDEBAR_STEP))
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    expect(onSave).toHaveBeenLastCalledWith(SIDEBAR_DEFAULT - SIDEBAR_STEP)
    fireEvent.keyDown(handle(), { key: 'Home' })
    expect(aside().style.width).toBe(px(SIDEBAR_MIN))
    // At the least already: nothing to save
    onSave.mockClear()
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    fireEvent.keyDown(handle(), { key: 'a' })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.keyDown(handle(), { key: 'End' })
    expect(aside().style.width).toBe(px(SIDEBAR_MAX))
    // Double click: back to the default
    fireEvent.doubleClick(handle())
    expect(aside().style.width).toBe(px(SIDEBAR_DEFAULT))
  })

  it('resizes by dragging, holding the terminal until release', () => {
    const { onSave, onResizing } = setup()
    // Not the main button: no drag
    fireEvent.pointerDown(handle(), { button: 2, clientX: 256 })
    fireEvent.pointerMove(handle(), { clientX: 400 })
    expect(aside().style.width).toBe(px(SIDEBAR_DEFAULT))
    expect(onResizing).not.toHaveBeenCalled()

    fireEvent.pointerDown(handle(), { button: 0, clientX: 256 })
    expect(onResizing).toHaveBeenLastCalledWith(true)
    expect(handle().className).toContain('bg-accent/40')
    // No width animation while the edge follows the pointer
    expect(aside().style.transition).toBe('none')
    fireEvent.pointerMove(handle(), { clientX: 356 })
    expect(aside().style.width).toBe(px(SIDEBAR_DEFAULT + 100))
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.pointerUp(handle())
    expect(onSave).toHaveBeenCalledWith(SIDEBAR_DEFAULT + 100)
    expect(onResizing).toHaveBeenLastCalledWith(false)
    expect(aside().style.transition).toBe('')

    // A second release, or a drag that ends where it began, saves nothing
    onSave.mockClear()
    fireEvent.pointerUp(handle())
    fireEvent.pointerDown(handle(), { button: 0, clientX: 500 })
    fireEvent.pointerCancel(handle())
    expect(onSave).not.toHaveBeenCalled()
    // Left past the least: held at it
    fireEvent.pointerDown(handle(), { button: 0, clientX: 500 })
    fireEvent.pointerMove(handle(), { clientX: 0 })
    fireEvent.lostPointerCapture(handle())
    expect(onSave).toHaveBeenCalledWith(SIDEBAR_MIN)
  })

  it('lets the terminal go when collapsed mid-drag', () => {
    const { rerender, onSave, onResizing } = setup()
    fireEvent.pointerDown(handle(), { button: 0, clientX: 256 })
    fireEvent.pointerMove(handle(), { clientX: 356 })
    rerender(<Harness collapsed onSave={onSave} onResizing={onResizing} />)
    expect(onResizing).toHaveBeenLastCalledWith(false)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('lets the terminal go when unmounted mid-drag', () => {
    const { unmount, onResizing } = setup()
    fireEvent.pointerDown(handle(), { button: 0, clientX: 256 })
    unmount()
    expect(onResizing).toHaveBeenLastCalledWith(false)
  })

  it('leaves the main area its room, measured as the row changes', () => {
    let resize: () => void = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resize = cb
        }
        observe() {}
        disconnect() {}
      },
    )
    let row = 2000
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
      () => row,
    )
    setup({ initial: 500 })
    expect(aside().style.width).toBe('500px')
    row = 800
    act(() => resize())
    expect(aside().style.width).toBe(px(800 - MAIN_MIN))
    expect(handle()).toHaveAttribute('aria-valuemax', String(800 - MAIN_MIN))
  })
})
