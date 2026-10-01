import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import { RequestError } from '../hooks/use-mux-api'
import { FileViewer } from './file-viewer'

const mockContent = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFileContent: (...a: unknown[]) => mockContent(...a),
}))
vi.mock('../utils/highlight', () => ({ highlight: async () => null }))
vi.mock('../hooks/use-media-query', () => ({ useIsMobile: () => false }))

function show(over: Partial<Parameters<typeof FileViewer>[0]> = {}) {
  const props = {
    paneId: '%1',
    root: '/r',
    path: 'src/a.ts',
    wrapByDefault: false,
    onClose: vi.fn(),
    onRootChanged: vi.fn(),
    notify: vi.fn(),
    ...over,
  }
  const view = render(
    <ThemeProvider>
      <FileViewer {...props} />
    </ThemeProvider>,
  )
  return { ...props, ...view }
}

beforeEach(() => {
  mockContent.mockReset()
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})
afterEach(() => vi.unstubAllGlobals())

describe('FileViewer', () => {
  it('shows a text file with its size, and goes back', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      size: 2048,
      text: 'x\ny',
    })
    const p = show()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(await screen.findByTestId('code-block')).toHaveTextContent('1x2y')
    expect(screen.getByText('2.0 KiB')).toBeInTheDocument()
    expect(mockContent).toHaveBeenCalledWith('%1', 'src/a.ts', {
      root: '/r',
      reveal: false,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    expect(p.onClose).toHaveBeenCalled()
  })

  it('toggles line wrapping', async () => {
    mockContent.mockResolvedValue({ root: '/r', path: 'a', size: 1, text: 'x' })
    show({ wrapByDefault: true })
    await screen.findByTestId('code-block')
    const wrap = screen.getByRole('button', { name: 'Wrap lines' })
    expect(wrap).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(wrap)
    expect(wrap).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('code-block').querySelector('code')).toHaveClass(
      'whitespace-pre',
    )
  })

  it('copies the path', async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('no'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    mockContent.mockResolvedValue({ root: '/r', path: 'a', size: 1, text: 'x' })
    const p = show()
    const copy = screen.getByRole('button', { name: 'Copy path' })
    await act(async () => fireEvent.click(copy))
    expect(writeText).toHaveBeenCalledWith('src/a.ts')
    expect(p.notify).toHaveBeenLastCalledWith('Path copied')
    await act(async () => fireEvent.click(copy))
    expect(p.notify).toHaveBeenLastCalledWith('Could not copy the path')
  })

  it('explains a file it cannot preview', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'a',
      size: 9,
      previewable: false,
      reason: 'binary',
    })
    show()
    expect(
      await screen.findByText(
        'Not previewable (binary, special file or larger than 1 MiB)',
      ),
    ).toBeInTheDocument()
  })

  it.each([
    [403, "This file can't be shown"],
    [404, 'File not found'],
    [501, 'Not supported by this backend'],
    [500, 'Could not load the file'],
  ])('a %i says why', async (status, text) => {
    mockContent.mockRejectedValue(new RequestError(status, '', 'x'))
    show()
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('asks before showing a sensitive file, then reads it with reveal', async () => {
    mockContent
      .mockResolvedValueOnce({ root: '/r', path: '.env', sensitive: true })
      .mockResolvedValueOnce({ root: '/r', path: '.env', size: 5, text: 'A=1' })
    show({ path: '.env' })
    expect(
      await screen.findByText(
        'This file may contain secrets. Show its contents?',
      ),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(await screen.findByTestId('code-block')).toHaveTextContent('A=1')
    expect(mockContent).toHaveBeenLastCalledWith('%1', '.env', {
      root: '/r',
      reveal: true,
    })
  })

  it('declining a sensitive file goes back to the tree', async () => {
    mockContent.mockResolvedValue({ root: '/r', path: '.env', sensitive: true })
    const p = show({ path: '.env' })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(p.onClose).toHaveBeenCalled()
    expect(mockContent).toHaveBeenCalledTimes(1)
  })

  it('a moved root is handed to the tree, which reads the file again', async () => {
    mockContent.mockRejectedValue(
      new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
    )
    const p = show()
    await act(async () => {})
    expect(p.onRootChanged).toHaveBeenCalledWith('/n')
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('drops an answer for a file no longer shown', async () => {
    let finish!: (v: unknown) => void
    let fail!: (e: unknown) => void
    mockContent
      .mockReturnValueOnce(new Promise((r) => (finish = r)))
      .mockReturnValueOnce(new Promise((_, r) => (fail = r)))
      .mockResolvedValueOnce({ root: '/r', path: 'c', size: 1, text: 'new' })
    const p = show()
    const again = (root: string) =>
      p.rerender(
        <ThemeProvider>
          <FileViewer {...p} root={root} />
        </ThemeProvider>,
      )
    again('/r2')
    again('/r3')
    await act(async () => {
      finish({ root: '/r', path: 'a', size: 1, text: 'old' })
      fail(new Error('offline'))
    })
    expect(await screen.findByTestId('code-block')).toHaveTextContent('new')
  })
})
