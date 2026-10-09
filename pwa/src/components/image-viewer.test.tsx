import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { viewerClosing } from '../hooks/use-history-close'
import { SETTLE_MS } from '../hooks/use-zoom-pan'
import ImageViewer from './image-viewer'

const SRC = 'data:image/svg+xml;charset=utf-8,%3Csvg%3E'

// The stage's size, read through clientWidth/clientHeight
const stageSize = { width: 400, height: 300 }

function show(over: Partial<Parameters<typeof ImageViewer>[0]> = {}) {
  const onClose = vi.fn()
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const view = render(
    <ImageViewer
      src={SRC}
      alt="Mermaid diagram 1"
      width={800}
      height={300}
      isSvg
      onClose={onClose}
      {...over}
    />,
  )
  const img = screen.getByAltText('Mermaid diagram 1') as HTMLImageElement
  return { ...view, onClose, opener, img, dialog: screen.getByRole('dialog') }
}

const popped = () =>
  new Promise<void>((r) =>
    window.addEventListener('popstate', () => r(), { once: true }),
  )

beforeEach(() => {
  window.history.replaceState(null, '', '/#/s/main/0')
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    () => stageSize.width,
  )
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
    () => stageSize.height,
  )
})
afterEach(async () => {
  vi.useRealTimers()
  // A viewer still open takes its entry off as it unmounts: wait for that
  // popstate, or it would land in the next test
  const pop = popped()
  cleanup()
  if (viewerClosing()) await pop
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('ImageViewer', () => {
  it('opens as a modal named by the image, fitted', () => {
    const { dialog, img } = show()
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalled()
    expect(dialog).toHaveAccessibleName('Mermaid diagram 1')
    // 800×300 in 400×300: half size, centred up and down; an SVG at rest is
    // drawn at that size, not scaled
    expect(img.style.width).toBe('400px')
    expect(img.style.height).toBe('150px')
    expect(img.style.transform).toBe('translate(0px, 75px)')
    expect(screen.getByText('100%')).toHaveAttribute('aria-live', 'polite')
  })

  it('zooms with the buttons and keys, and Fit goes back', () => {
    const { dialog } = show()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByText('125%')).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: '+' })
    expect(screen.getByText('156%')).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: '-' })
    fireEvent.keyDown(dialog, { key: '=' })
    expect(screen.getByText('156%')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }))
    expect(screen.getByText('125%')).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: '0' })
    expect(screen.getByText('100%')).toBeInTheDocument()
    fireEvent.keyDown(dialog, { key: '+' })
    fireEvent.click(screen.getByRole('button', { name: 'Fit' }))
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('leaves the browser’s own zoom keys (Ctrl/Cmd/Alt) alone', () => {
    const { dialog } = show()
    for (const mod of ['ctrlKey', 'metaKey', 'altKey']) {
      fireEvent.keyDown(dialog, { key: '0', [mod]: true })
      fireEvent.keyDown(dialog, { key: '+', [mod]: true })
    }
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('reads the zoom out only once a gesture ends', () => {
    vi.useFakeTimers()
    show()
    const stage = screen.getByTestId('viewer-stage')
    HTMLElement.prototype.setPointerCapture = vi.fn()
    expect(screen.getByText('100%')).toHaveAttribute('aria-busy', 'false')
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 10, clientY: 10 })
    expect(screen.getByText('100%')).toHaveAttribute('aria-busy', 'true')
  })

  it('leaves other keys to the dialog', () => {
    const { dialog } = show()
    const ev = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
      cancelable: true,
    })
    dialog.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  })

  it('scales an SVG while a gesture runs, then draws it at its new size', () => {
    vi.useFakeTimers()
    const { img } = show()
    const stage = screen.getByTestId('viewer-stage')
    HTMLElement.prototype.setPointerCapture = vi.fn()
    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 10, clientY: 10 })
    expect(img.style.width).toBe('800px')
    expect(img.style.transform).toBe('translate(0px, 75px) scale(0.5)')
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(SETTLE_MS))
    expect(img.style.width).toBe('400px')
  })

  it('always scales a bitmap', () => {
    const { img } = show({ isSvg: false })
    expect(img.style.width).toBe('800px')
    expect(img.style.transform).toBe('translate(0px, 75px) scale(0.5)')
  })

  it('reads the size of an image once it loads', () => {
    const { img } = show({ width: undefined, height: undefined, isSvg: false })
    expect(img.style.visibility).toBe('hidden')
    Object.defineProperty(img, 'naturalWidth', { value: 200 })
    Object.defineProperty(img, 'naturalHeight', { value: 100 })
    fireEvent.load(img)
    expect(img.style.visibility).toBe('')
    // Smaller than the stage: its own size, centred
    expect(img.style.transform).toBe('translate(100px, 100px) scale(1)')
    // A second load (the same URL) changes nothing
    fireEvent.load(img)
    expect(img.style.width).toBe('200px')
  })

  it('an SVG without a size of its own takes the stage’s', () => {
    const { img } = show({ width: undefined, height: undefined })
    fireEvent.load(img)
    expect(img.style.width).toBe('400px')
    expect(img.style.height).toBe('300px')
  })

  it('X goes back through the history, then closes and returns focus', async () => {
    const { onClose, opener, unmount } = show()
    expect(window.history.state?.termoteViewer).toEqual(expect.any(String))
    const pop = popped()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).not.toHaveBeenCalled()
    await pop
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    expect(document.activeElement).toBe(opener)
  })

  it('Escape (the dialog’s cancel) closes the same way', async () => {
    const { onClose, dialog } = show()
    const pop = popped()
    const cancel = new Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
    await pop
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes through the history once its URL is stale', async () => {
    const { onClose, rerender } = show()
    const pop = popped()
    rerender(
      <ImageViewer
        src={SRC}
        alt="Mermaid diagram 1"
        width={800}
        height={300}
        isSvg
        stale
        onClose={onClose}
      />,
    )
    await pop
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Back closes it', async () => {
    const { onClose } = show()
    const pop = popped()
    window.history.back()
    await pop
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
