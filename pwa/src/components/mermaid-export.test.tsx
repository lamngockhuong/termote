import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MermaidImage } from '../utils/mermaid-render'
import { MermaidExport } from './mermaid-export'

const mockShare = vi.fn()
const mockCopy = vi.fn()
const mockDownload = vi.fn()
vi.mock('../utils/mermaid-export', async (orig) => ({
  ...(await orig<typeof import('../utils/mermaid-export')>()),
  sharePng: (...a: unknown[]) => mockShare(...a),
  copyPng: (...a: unknown[]) => mockCopy(...a),
  downloadSvg: (...a: unknown[]) => mockDownload(...a),
}))

const IMG: MermaidImage = {
  url: 'data:image/svg+xml;charset=utf-8,%3Csvg%3E',
  width: 300,
  height: 120,
  background: '#fff',
}

// A browser that can share a PNG file and copy an image, unless told not to
function secureBrowser({
  secure = true,
  canShare = true,
  canCopy = true,
}: {
  secure?: boolean
  canShare?: boolean
  canCopy?: boolean
} = {}) {
  vi.stubGlobal('isSecureContext', secure)
  vi.stubGlobal('ClipboardItem', class {})
  if (!canCopy) Object.assign(ClipboardItem, { supports: () => false })
  vi.stubGlobal('navigator', {
    userAgent: navigator.userAgent,
    share: vi.fn(),
    canShare: () => canShare,
    clipboard: { write: vi.fn() },
  })
}

const notify = vi.fn()
const names = () =>
  screen.queryAllByRole('button').map((b) => b.getAttribute('aria-label'))

beforeEach(() => {
  mockShare.mockReset()
  mockCopy.mockReset()
  mockDownload.mockReset()
  notify.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('MermaidExport', () => {
  it('offers share, copy and SVG download, in that order, in a secure browser', () => {
    secureBrowser()
    render(<MermaidExport image={IMG} name="a-mermaid-1" notify={notify} />)
    expect(names()).toEqual([
      'Share diagram as PNG',
      'Copy diagram as image',
      'Download diagram as SVG',
    ])
  })

  it('offers only the SVG download over plain HTTP', () => {
    secureBrowser({ secure: false })
    render(<MermaidExport image={IMG} name="a-mermaid-1" notify={notify} />)
    expect(names()).toEqual(['Download diagram as SVG'])
  })

  it('leaves out share when the sheet takes no PNG file', () => {
    secureBrowser({ canShare: false })
    render(<MermaidExport image={IMG} name="a-mermaid-1" notify={notify} />)
    expect(names()).toEqual([
      'Copy diagram as image',
      'Download diagram as SVG',
    ])
  })

  it('leaves out copy when the browser cannot take a PNG', () => {
    secureBrowser({ canCopy: false })
    render(<MermaidExport image={IMG} name="a-mermaid-1" notify={notify} />)
    expect(names()).toEqual(['Share diagram as PNG', 'Download diagram as SVG'])
  })

  it('shares, copies and downloads the diagram under its name, telling the user through notify', () => {
    secureBrowser()
    render(<MermaidExport image={IMG} name="a-mermaid-1" notify={notify} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Share diagram as PNG' }),
    )
    expect(mockShare).toHaveBeenCalledWith(
      IMG,
      'a-mermaid-1',
      notify,
      expect.any(Function),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy diagram as image' }),
    )
    expect(mockCopy).toHaveBeenCalledWith(IMG, notify, expect.any(Function))
    fireEvent.click(
      screen.getByRole('button', { name: 'Download diagram as SVG' }),
    )
    expect(mockDownload).toHaveBeenCalledWith(
      IMG,
      'a-mermaid-1',
      notify,
      expect.any(Function),
    )
  })

  it('hands every button to buttonRef', () => {
    secureBrowser()
    const buttonRef = vi.fn()
    render(
      <MermaidExport
        image={IMG}
        name="a-mermaid-1"
        notify={notify}
        buttonRef={buttonRef}
      />,
    )
    expect(buttonRef).toHaveBeenCalledTimes(3)
    for (const [el] of buttonRef.mock.calls)
      expect(el).toBeInstanceOf(HTMLButtonElement)
  })

  it('sizes its buttons by the size given', () => {
    secureBrowser({ secure: false })
    const { rerender } = render(
      <MermaidExport image={IMG} name="a-mermaid-1" notify={notify} />,
    )
    const medium = screen.getByRole('button').className
    rerender(
      <MermaidExport
        image={IMG}
        name="a-mermaid-1"
        notify={notify}
        size="sm"
      />,
    )
    expect(screen.getByRole('button').className).not.toBe(medium)
  })
})
