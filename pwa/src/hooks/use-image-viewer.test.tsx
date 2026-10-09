import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useImageViewer, type ViewerImage } from './use-image-viewer'

const h = vi.hoisted(() => ({
  loaded: vi.fn(),
  closing: false,
  onClose: (() => {}) as () => void,
}))

vi.mock('../components/image-viewer', () => {
  h.loaded()
  return {
    default: (p: ViewerImage & { stale: boolean; onClose: () => void }) => {
      h.onClose = p.onClose
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
vi.mock('./use-history-close', () => ({ viewerClosing: () => h.closing }))

let open: (image: ViewerImage) => void = () => {}
function Host({ src }: { src?: string }) {
  const v = useImageViewer(src)
  open = v.open
  return <>{v.viewer}</>
}

const IMAGE: ViewerImage = { src: 'blob:a', alt: 'logo.png', isSvg: false }

beforeEach(() => {
  h.closing = false
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
})
