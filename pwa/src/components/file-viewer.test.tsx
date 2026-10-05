import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { ThemeProvider } from '../contexts/theme-context'
import { RequestError } from '../hooks/use-mux-api'
import { FileViewer } from './file-viewer'

const mockContent = vi.fn()
const mockImage = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFileContent: (...a: unknown[]) => mockContent(...a),
  fetchFileImage: (...a: unknown[]) => mockImage(...a),
}))
vi.mock('../utils/highlight', async (orig) => ({
  ...(await orig<typeof import('../utils/highlight')>()),
  highlight: async () => null,
  highlightLang: async () => null,
}))
vi.mock('../hooks/use-media-query', () => ({ useIsMobile: () => false }))

function show(over: Partial<Parameters<typeof FileViewer>[0]> = {}) {
  const props = {
    paneId: '%1',
    root: '/r',
    path: 'src/a.ts',
    wrapByDefault: false,
    onClose: vi.fn(),
    onFollow: vi.fn(),
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

// The lazy Markdown renderer, loaded once up front: its first load can
// outlast a find under coverage
beforeAll(() => import('./markdown-preview'))

beforeEach(() => {
  localStorage.clear()
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
    // The dialog's text renders before showModal opens it, and its buttons are
    // only accessible once it is open
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
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

  it('names the file Back returns to', async () => {
    mockContent.mockResolvedValue({ root: '/r', path: 'a', size: 1, text: 'x' })
    show({ backTo: 'docs/README.md' })
    expect(
      screen.getByRole('button', { name: 'Back to README.md' }),
    ).toBeInTheDocument()
  })
})

describe('FileViewer: Markdown', () => {
  const md = (text: string, size = text.length) => ({
    root: '/r',
    path: 'docs/a.md',
    size,
    text,
  })

  it('previews Markdown first, and remembers Source', async () => {
    mockContent.mockResolvedValue(md('# Title\n\nBody'))
    const p = show({ path: 'docs/a.md' })
    expect(await screen.findByTestId('markdown-preview')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Preview' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(toggle)
    expect(await screen.findByTestId('code-block')).toHaveTextContent('# Title')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(
      JSON.parse(localStorage.getItem('termote-settings') ?? '{}'),
    ).toEqual(expect.objectContaining({ markdownPreview: false }))

    // Opened again: still the source
    p.unmount()
    show({ path: 'docs/a.md' })
    expect(await screen.findByTestId('code-block')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByTestId('markdown-preview')).toBeInTheDocument()
  })

  it('shows a large Markdown file as its source, saying why', async () => {
    mockContent.mockResolvedValue(md('# Big', 300 * 1024))
    show({ path: 'docs/a.md' })
    expect(await screen.findByTestId('code-block')).toBeInTheDocument()
    expect(screen.getByText(/Too large to preview/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
  })

  it('has no preview for other files', async () => {
    mockContent.mockResolvedValue({ root: '/r', path: 'a', size: 1, text: 'x' })
    show()
    await screen.findByTestId('code-block')
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(screen.queryByText(/Too large/)).toBeNull()
  })

  it('previews nothing of a sensitive file before Show', async () => {
    mockContent
      .mockResolvedValueOnce({ root: '/r', path: '.env.md', sensitive: true })
      .mockResolvedValueOnce(md('# Secret'))
    show({ path: '.env.md' })
    expect(
      await screen.findByText('This file may contain secrets'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('markdown-preview')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    // The dialog's text renders before showModal opens it, and its buttons are
    // only accessible once it is open
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    expect(await screen.findByTestId('markdown-preview')).toHaveTextContent(
      'Secret',
    )
  })

  it('starts at the heading of the link once, not again after Source', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    mockContent.mockResolvedValue(md('# A\n\n## Usage'))
    show({ path: 'docs/a.md', anchor: 'usage' })
    await screen.findByTestId('markdown-preview')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)

    const toggle = screen.getByRole('button', { name: 'Preview' })
    fireEvent.click(toggle)
    await screen.findByTestId('code-block')
    fireEvent.click(toggle)
    expect(await screen.findByTestId('markdown-preview')).toBeInTheDocument()
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('restores where Back left it once, not again after Source', async () => {
    mockContent.mockResolvedValue(md('# A'))
    show({ path: 'docs/a.md', scrollTop: 120 })
    expect((await screen.findByTestId('markdown-preview')).scrollTop).toBe(120)

    const toggle = screen.getByRole('button', { name: 'Preview' })
    fireEvent.click(toggle)
    await screen.findByTestId('code-block')
    fireEvent.click(toggle)
    expect((await screen.findByTestId('markdown-preview')).scrollTop).toBe(0)
  })

  it('starts at the heading when Source showed first', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ markdownPreview: false }),
    )
    mockContent.mockResolvedValue(md('# A\n\n## Usage'))
    show({ path: 'docs/a.md', anchor: 'usage' })
    await screen.findByTestId('code-block')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByTestId('markdown-preview')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('hands a followed link and where it was left to the caller', async () => {
    mockContent.mockResolvedValue(md('[guide](guide.md#usage)'))
    const p = show({ path: 'docs/a.md' })
    fireEvent.click(await screen.findByRole('button', { name: 'guide' }))
    expect(p.onFollow).toHaveBeenCalledWith(
      { kind: 'path', path: 'docs/guide.md', anchor: 'usage' },
      0,
    )
  })
})

describe('FileViewer: images', () => {
  let made = 0
  beforeEach(() => {
    made = 0
    mockImage.mockReset()
    mockImage.mockResolvedValue(new Blob(['12345']))
    URL.createObjectURL = vi.fn(() => `blob:u${++made}`)
    URL.revokeObjectURL = vi.fn()
  })

  it('shows an image with its size, without reading it as text', async () => {
    show({ path: 'img/a.PNG' })
    const img = await screen.findByRole('img', { name: 'img/a.PNG' })
    expect(img).toHaveAttribute('src', 'blob:u1')
    expect(screen.getAllByText('5 B')).toHaveLength(2)
    expect(mockContent).not.toHaveBeenCalled()
    expect(mockImage).toHaveBeenCalledWith(
      '%1',
      'img/a.PNG',
      expect.objectContaining({ root: '/r', reveal: false }),
      expect.any(AbortSignal),
    )
    // Nothing to wrap, nothing to preview
    expect(screen.queryByRole('button', { name: 'Wrap lines' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Image' })).toBeNull()
  })

  it('asks before showing a sensitive image, then reads it revealed', async () => {
    mockImage.mockRejectedValueOnce(
      new RequestError(403, 'sensitive', 'sensitive'),
    )
    show({ path: 'secrets.png' })
    expect(
      await screen.findByText('This file may contain secrets'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(await screen.findByRole('img')).toBeInTheDocument()
    expect(mockImage.mock.calls[1][2]).toMatchObject({ reveal: true })
  })

  it('says why an image cannot be shown, and retries when busy', async () => {
    mockImage.mockRejectedValueOnce(new RequestError(429, 'busy', 'busy'))
    show({ path: 'a.png' })
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('img')).toBeInTheDocument()
    expect(mockImage).toHaveBeenCalledTimes(2)
  })

  it('hands a moved root to the caller', async () => {
    mockImage.mockRejectedValue(
      new RequestError(409, '', 'root changed', undefined, undefined, '/new'),
    )
    const p = show({ path: 'a.png' })
    await waitFor(() => expect(p.onRootChanged).toHaveBeenCalledWith('/new'))
  })

  it('shows an SVG as text until Image is picked, and remembers it', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'logo.svg',
      size: 6,
      text: '<svg/>',
    })
    const p = show({ path: 'logo.svg' })
    expect(await screen.findByTestId('code-block')).toHaveTextContent('<svg/>')
    expect(mockImage).not.toHaveBeenCalled()
    const toggle = screen.getByRole('button', { name: 'Image' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:u1')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(
      JSON.parse(localStorage.getItem('termote-settings') ?? '{}'),
    ).toEqual(expect.objectContaining({ svgPreview: true }))

    // Opened again: still the image; back to the source
    p.unmount()
    show({ path: 'logo.svg' })
    expect(await screen.findByRole('img')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Image' }))
    expect(await screen.findByTestId('code-block')).toBeInTheDocument()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:u2')
  })
})
