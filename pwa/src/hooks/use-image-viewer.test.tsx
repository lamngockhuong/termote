import { act, render, screen, waitFor } from '@testing-library/react'
import type { RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useImageViewer, type ViewerImage } from './use-image-viewer'

const h = vi.hoisted(() => ({
  loaded: vi.fn(),
  fail: false,
  retried: vi.fn(),
  closing: false,
  onClose: (() => {}) as () => void,
  returnFocus: undefined as RefObject<HTMLElement | null> | undefined,
  actions: undefined as unknown,
}))

vi.mock('../components/image-viewer', () => {
  h.loaded()
  return {
    default: (
      p: ViewerImage & {
        stale: boolean
        returnFocus?: RefObject<HTMLElement | null>
        actions?: unknown
        onClose: () => void
      },
    ) => {
      if (h.fail) throw new Error('viewer broke')
      h.onClose = p.onClose
      h.returnFocus = p.returnFocus
      h.actions = p.actions
      return (
        <div
          data-testid="viewer"
          data-src={p.src}
          data-alt={p.alt}
          data-stale={String(p.stale)}
        />
      )
    },
  }
})
// The real lazyRetry, told when its retry() is called
vi.mock('../utils/lazy-retry', async (orig) => {
  const real = await orig<typeof import('../utils/lazy-retry')>()
  return {
    lazyRetry: (...a: Parameters<typeof real.lazyRetry>) => {
      const lazy = real.lazyRetry(...a)
      const retry = lazy.retry
      lazy.retry = () => {
        h.retried()
        retry()
      }
      return lazy
    },
  }
})
vi.mock('./use-history-close', () => ({ viewerClosing: () => h.closing }))

let open: (image: ViewerImage) => void = () => {}
let failed = false
const home: RefObject<HTMLElement | null> = { current: null }
const actions = () => null
function Host({ src, withActions }: { src?: string; withActions?: boolean }) {
  const v = useImageViewer(src, home, withActions ? actions : undefined)
  open = v.open
  failed = v.failed
  return <>{v.viewer}</>
}

const IMAGE: ViewerImage = { src: 'blob:a', alt: 'logo.png', isSvg: false }

beforeEach(() => {
  h.closing = false
  h.fail = false
  h.retried.mockClear()
})

describe('useImageViewer', () => {
  it('loads the viewer only once an image is opened, then closes it', async () => {
    render(<Host src="blob:a" />)
    expect(screen.queryByTestId('viewer')).toBeNull()
    expect(h.loaded).not.toHaveBeenCalled()
    act(() => open(IMAGE))
    const viewer = await screen.findByTestId('viewer')
    expect(h.loaded).toHaveBeenCalledTimes(1)
    expect(viewer).toHaveAttribute('data-alt', 'logo.png')
    expect(viewer).toHaveAttribute('data-stale', 'false')
    expect(h.returnFocus).toBe(home)
    act(() => h.onClose())
    expect(screen.queryByTestId('viewer')).toBeNull()
  })

  it('tells the viewer once the image shows another URL', async () => {
    const view = render(<Host src="blob:a" />)
    act(() => open(IMAGE))
    await screen.findByTestId('viewer')
    view.rerender(<Host src="blob:b" />)
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-stale', 'true')
    expect(screen.getByTestId('viewer')).toHaveAttribute('data-src', 'blob:a')
  })

  it('opens nothing while the last viewer is still leaving the history', () => {
    h.closing = true
    render(<Host src="blob:a" />)
    act(() => open(IMAGE))
    expect(screen.queryByTestId('viewer')).toBeNull()
  })

  it('gives the viewer the actions for its bar', async () => {
    render(<Host src="blob:a" withActions />)
    act(() => open(IMAGE))
    await screen.findByTestId('viewer')
    expect(h.actions).toBe(actions)
  })

  it('closes when the viewer cannot be loaded, and loads it on the next open', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.fail = true
    render(<Host src="blob:a" />)
    expect(failed).toBe(false)
    act(() => open(IMAGE))
    await waitFor(() => expect(failed).toBe(true))
    expect(h.retried).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('viewer')).toBeNull()
    expect(error).toHaveBeenCalledWith(
      'Could not load a lazy component',
      expect.any(Error),
    )
    h.fail = false
    act(() => open(IMAGE))
    expect(await screen.findByTestId('viewer')).toBeInTheDocument()
    expect(failed).toBe(false)
    error.mockRestore()
  })

  it('stops reporting the failure once the image shows another URL', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.fail = true
    const view = render(<Host src="blob:a" />)
    act(() => open(IMAGE))
    await waitFor(() => expect(failed).toBe(true))
    view.rerender(<Host src="blob:b" />)
    expect(failed).toBe(false)
    error.mockRestore()
  })
})
