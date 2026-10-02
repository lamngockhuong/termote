import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelMaximizeButton, SidePanel } from './side-panel'

// Reports the row width the panel measures, on demand.
let reportRow: (() => void) | null = null
class FakeResizeObserver {
  constructor(private cb: () => void) {}
  observe() {
    reportRow = () => this.cb()
  }
  disconnect() {
    reportRow = null
  }
}

function setup({
  width = 440 as unknown,
  maximized = false,
  rowWidth,
}: {
  width?: unknown
  maximized?: boolean
  rowWidth?: number
} = {}) {
  const onWidthChange = vi.fn()
  const onMaximizedChange = vi.fn()
  const onResizingChange = vi.fn()
  const props = {
    label: 'Files',
    onWidthChange,
    onMaximizedChange,
    onResizingChange,
  }
  const ui = (w: unknown, m: boolean) => (
    <div data-testid="row">
      <SidePanel {...props} width={w} maximized={m}>
        <PanelMaximizeButton />
        <input aria-label="inside" />
      </SidePanel>
    </div>
  )
  const view = render(ui(width, maximized))
  if (rowWidth !== undefined) {
    Object.defineProperty(screen.getByTestId('row'), 'clientWidth', {
      configurable: true,
      value: rowWidth,
    })
    act(() => reportRow?.())
  }
  return {
    ...view,
    onWidthChange,
    onMaximizedChange,
    onResizingChange,
    rerender: (w: unknown, m = maximized) => view.rerender(ui(w, m)),
  }
}

const panel = () => screen.getByRole('complementary', { name: 'Files' })
const handle = () => screen.getByRole('separator', { name: 'Resize Files' })

describe('SidePanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    reportRow = null
  })

  it('shows the saved width on a separator with its values', () => {
    setup({ width: 520 })
    expect(panel()).toHaveStyle({ width: '520px' })
    expect(handle()).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle()).toHaveAttribute('aria-valuenow', '520')
    expect(handle()).toHaveAttribute('aria-valuemin', '320')
    // Not measured (no ResizeObserver): no maximum yet
    expect(handle()).not.toHaveAttribute('aria-valuemax')
    expect(handle()).toHaveAttribute('tabindex', '0')
  })

  it('keeps within the row, and grows back when the row does', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const { onWidthChange } = setup({ width: 900, rowWidth: 1000 })
    expect(panel()).toHaveStyle({ width: '640px' })
    expect(handle()).toHaveAttribute('aria-valuemax', '640')
    Object.defineProperty(screen.getByTestId('row'), 'clientWidth', {
      configurable: true,
      value: 1400,
    })
    act(() => reportRow!())
    expect(panel()).toHaveStyle({ width: '900px' })
    // Shrinking to fit does not overwrite the saved width
    expect(onWidthChange).not.toHaveBeenCalled()
  })

  it('stops measuring once unmounted', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const { unmount } = setup({ rowWidth: 1000 })
    unmount()
    expect(reportRow).toBeNull()
  })

  it('follows the pointer while dragged and saves once on release', () => {
    const capture = vi.fn()
    const { onWidthChange, onResizingChange } = setup()
    handle().setPointerCapture = capture
    fireEvent.pointerDown(handle(), { button: 0, clientX: 1000, pointerId: 3 })
    expect(capture).toHaveBeenCalledWith(3)
    expect(onResizingChange).toHaveBeenLastCalledWith(true)
    fireEvent.pointerMove(handle(), { clientX: 900 })
    expect(panel()).toHaveStyle({ width: '540px' })
    fireEvent.pointerMove(handle(), { clientX: 950 })
    expect(panel()).toHaveStyle({ width: '490px' })
    expect(onWidthChange).not.toHaveBeenCalled()
    fireEvent.pointerUp(handle())
    expect(onWidthChange).toHaveBeenCalledTimes(1)
    expect(onWidthChange).toHaveBeenCalledWith(490)
    expect(onResizingChange).toHaveBeenLastCalledWith(false)
    // The capture lost after the release ends nothing more
    fireEvent.lostPointerCapture(handle())
    expect(onResizingChange).toHaveBeenCalledTimes(2)
  })

  it('a drag stays within the limits', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const { onWidthChange } = setup({ rowWidth: 1000 })
    fireEvent.pointerDown(handle(), { button: 0, clientX: 500 })
    fireEvent.pointerMove(handle(), { clientX: 0 })
    expect(panel()).toHaveStyle({ width: '640px' })
    fireEvent.pointerMove(handle(), { clientX: 1000 })
    expect(panel()).toHaveStyle({ width: '320px' })
    fireEvent.pointerCancel(handle())
    expect(onWidthChange).toHaveBeenCalledWith(320)
  })

  it('a click without a move saves nothing; other buttons and stray moves do nothing', () => {
    const { onWidthChange, onResizingChange } = setup()
    fireEvent.pointerMove(handle(), { clientX: 10 })
    fireEvent.pointerDown(handle(), { button: 2, clientX: 10 })
    expect(onResizingChange).not.toHaveBeenCalled()
    fireEvent.pointerDown(handle(), { button: 0, clientX: 10 })
    fireEvent.pointerUp(handle())
    expect(onWidthChange).not.toHaveBeenCalled()
    expect(onResizingChange).toHaveBeenLastCalledWith(false)
  })

  it('double-click resets the width', () => {
    const { onWidthChange } = setup({ width: 700 })
    fireEvent.doubleClick(handle())
    expect(onWidthChange).toHaveBeenCalledWith(440)
  })

  it('steps with the arrow keys and goes to the limits with Home/End', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const { onWidthChange } = setup({ rowWidth: 1000 })
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    expect(onWidthChange).toHaveBeenLastCalledWith(456)
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    expect(onWidthChange).toHaveBeenLastCalledWith(424)
    fireEvent.keyDown(handle(), { key: 'Home' })
    expect(onWidthChange).toHaveBeenLastCalledWith(320)
    fireEvent.keyDown(handle(), { key: 'End' })
    expect(onWidthChange).toHaveBeenLastCalledWith(640)
    onWidthChange.mockClear()
    fireEvent.keyDown(handle(), { key: 'a' })
    expect(onWidthChange).not.toHaveBeenCalled()
  })

  it('a key at a limit saves nothing, and End waits for the row', () => {
    const { onWidthChange } = setup({ width: 320 })
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    fireEvent.keyDown(handle(), { key: 'Home' })
    fireEvent.keyDown(handle(), { key: 'End' })
    expect(onWidthChange).not.toHaveBeenCalled()
  })

  it('maximizes from the button and restores from it or Escape', () => {
    const { onMaximizedChange, rerender } = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Maximize panel' }))
    expect(onMaximizedChange).toHaveBeenLastCalledWith(true)
    // Escape does nothing to a panel at its width
    fireEvent.keyDown(screen.getByLabelText('inside'), { key: 'Escape' })
    expect(onMaximizedChange).toHaveBeenCalledTimes(1)

    rerender(440, true)
    expect(panel()).toHaveClass('absolute', 'inset-0')
    expect(panel().style.width).toBe('')
    expect(screen.queryByRole('separator')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Restore panel' }))
    expect(onMaximizedChange).toHaveBeenLastCalledWith(false)
    fireEvent.keyDown(screen.getByLabelText('inside'), { key: 'Enter' })
    expect(onMaximizedChange).toHaveBeenCalledTimes(2)
    fireEvent.keyDown(screen.getByLabelText('inside'), { key: 'Escape' })
    expect(onMaximizedChange).toHaveBeenCalledTimes(3)
    expect(onMaximizedChange).toHaveBeenLastCalledWith(false)
  })

  it('Escape restores with the focus outside the panel too', () => {
    const { onMaximizedChange, unmount } = setup({ maximized: true })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onMaximizedChange).toHaveBeenCalledWith(false)
    unmount()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onMaximizedChange).toHaveBeenCalledTimes(1)
  })

  it('measures the row before the first paint', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const spy = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockReturnValue(1000)
    setup({ width: 900 })
    spy.mockRestore()
    expect(panel()).toHaveStyle({ width: '640px' })
  })

  it('leaves an Escape used inside the panel alone', () => {
    const { onMaximizedChange } = setup({ maximized: true })
    const input = screen.getByLabelText('inside')
    input.addEventListener('keydown', (e) => e.preventDefault())
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onMaximizedChange).not.toHaveBeenCalled()
  })

  it('leaves an Escape in a dialog to the dialog', () => {
    const onMaximizedChange = vi.fn()
    render(
      <SidePanel
        label="Files"
        width={440}
        maximized
        onWidthChange={vi.fn()}
        onMaximizedChange={onMaximizedChange}
        onResizingChange={vi.fn()}
      >
        <dialog open>
          <button>Cancel</button>
        </dialog>
      </SidePanel>,
    )
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), {
      key: 'Escape',
    })
    expect(onMaximizedChange).not.toHaveBeenCalled()
  })

  it('a drag cut short by an unmount releases the terminal', () => {
    const { onResizingChange, unmount } = setup()
    fireEvent.pointerDown(handle(), { button: 0, clientX: 10 })
    unmount()
    expect(onResizingChange).toHaveBeenLastCalledWith(false)
  })

  it('an unmount after a drag ended reports nothing more', () => {
    const { onResizingChange, unmount } = setup()
    unmount()
    expect(onResizingChange).not.toHaveBeenCalled()
  })

  it('the maximize button is drawn only inside the panel', () => {
    render(<PanelMaximizeButton />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
