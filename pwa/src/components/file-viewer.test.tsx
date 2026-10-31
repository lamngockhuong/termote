import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
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
import {
  type FileDraft,
  resetFilesStores,
  useFileDraft,
} from '../hooks/use-files'
import { RequestError } from '../hooks/use-mux-api'
import type { SyncSide } from '../hooks/use-scroll-sync'
import type { TableOp } from '../utils/csv-edits'
import type { PasteEdit } from '../utils/markdown-image-paste'
import { paneSelection, resetPaneSelections } from '../utils/pane-selection'
import {
  FileViewer,
  HeaderActions,
  PREVIEW_MAX_BYTES,
  rebaseDraft,
} from './file-viewer'

const mockContent = vi.fn()
const mockImage = vi.fn()
const mockDocument = vi.fn()
const mockSave = vi.fn()
// The desktop editor: shows where it was told to open
// What the desktop editor gives a preview that scrolls with it, when set
const sync = vi.hoisted(() => ({ side: undefined as SyncSide | undefined }))
vi.mock('./code-editor', async () => {
  const { useEffect } = await import('react')
  return { default: MockCodeEditor }
  function MockCodeEditor(p: {
    path: string
    text: string
    onChange: (text: string) => void
    at?: { line: number; col?: number }
    hidden?: boolean
    onSyncSide?: (side: SyncSide | null) => void
    onPasteImage?: (file: File, edit: PasteEdit) => void
  }) {
    // Given once, like the editor
    useEffect(() => {
      if (!p.onSyncSide || !sync.side) return
      p.onSyncSide(sync.side)
      return () => p.onSyncSide?.(null)
    }, [])
    return (
      <div data-testid="code-editor" data-hidden={String(!!p.hidden)}>
        at {p.at ? `${p.at.line}:${p.at.col ?? 0}` : 'none'}
        <input
          aria-label={`Text of ${p.path}`}
          data-scroll-restore
          value={p.text}
          onChange={(e) => p.onChange(e.target.value)}
          // An image pasted goes in at the end
          onPaste={(e) => {
            const file = e.clipboardData.items[0]?.getAsFile()
            if (!file || !p.onPasteImage) return
            e.preventDefault()
            // Never swapped here: the viewer changes the draft
            p.onPasteImage(file, {
              insert: (text) => p.onChange(p.text + text),
              replace: () => false,
            })
          }}
        />
      </div>
    )
  }
})

// The PDF viewer (pdf.js) does not run in jsdom: its own tests stand it in
vi.mock('./pdf-preview', () => ({
  default: (p: { path: string }) => <div data-testid="pdf">{p.path}</div>,
}))
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFileContent: (...a: unknown[]) => mockContent(...a),
  fetchFileImage: (...a: unknown[]) => mockImage(...a),
  fetchFileDocument: (...a: unknown[]) => mockDocument(...a),
  saveFileContent: (...a: unknown[]) => mockSave(...a),
}))
const mockPasteUpload = vi.fn()
vi.mock('../utils/upload-image', async (orig) => ({
  ...(await orig<typeof import('../utils/upload-image')>()),
  uploadFileImage: (...a: unknown[]) => mockPasteUpload(...a),
}))
vi.mock('../utils/highlight', async (orig) => ({
  ...(await orig<typeof import('../utils/highlight')>()),
  highlight: async () => null,
  highlightLang: async () => null,
}))
// Times the Markdown of a preview was parsed (its rehype plugins attached)
const parses = vi.hoisted(() => ({ n: 0 }))
vi.mock('../utils/markdown-links', async (orig) => {
  const m = await orig<typeof import('../utils/markdown-links')>()
  return {
    ...m,
    rehypeHeadingIds: (...a: Parameters<typeof m.rehypeHeadingIds>) => {
      parses.n++
      return m.rehypeHeadingIds(...a)
    },
  }
})
// A fine pointer (a mouse) when set; no pointer the query names otherwise.
// The viewer's width: 0 as without ResizeObserver
const pointer = vi.hoisted(() => ({ fine: false, width: 0 }))
vi.mock('../hooks/use-media-query', () => ({
  useIsMobile: () => false,
  useMediaQuery: (query: string) => query === '(pointer: fine)' && pointer.fine,
}))
vi.mock('../hooks/use-element-width', () => ({
  useElementWidth: () => pointer.width,
}))

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
beforeAll(() =>
  Promise.all([import('./markdown-preview'), import('./table-preview')]),
)

beforeEach(() => {
  localStorage.clear()
  resetFilesStores()
  mockContent.mockReset()
  mockSave.mockReset()
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
    expect(mockContent).toHaveBeenCalledWith({ paneId: '%1' }, 'src/a.ts', {
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

  it('opens the file in a new window when offered, Shift as a popup', async () => {
    mockContent.mockResolvedValue({ root: '/r', path: 'a', size: 1, text: 'x' })
    const onOpenWindow = vi.fn()
    show({ onOpenWindow })
    const button = screen.getByRole('button', { name: 'Open in new window' })
    fireEvent.click(button)
    fireEvent.click(button, { shiftKey: true })
    expect(onOpenWindow.mock.calls).toEqual([
      [{ shiftKey: false }],
      [{ shiftKey: true }],
    ])
  })

  it('offers no new window unless given', async () => {
    mockContent.mockResolvedValue({ root: '/r', path: 'a', size: 1, text: 'x' })
    show()
    expect(
      screen.queryByRole('button', { name: 'Open in new window' }),
    ).toBeNull()
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
        'Not previewable (binary, special file or larger than 4 MiB)',
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
    expect(mockContent).toHaveBeenLastCalledWith({ paneId: '%1' }, '.env', {
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
      new RequestError(409, '', 'root changed', { root: '/n' }),
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
      { newTab: false },
    )
  })
})

describe('FileViewer: tables', () => {
  const csv = (text: string, path = 'data/a.csv') => ({
    root: '/r',
    path,
    size: text.length,
    text,
  })

  it('shows a CSV as a table, and remembers Source', async () => {
    mockContent.mockResolvedValue(csv('name,age\nAn,3\n'))
    const p = show({ path: 'data/a.csv' })
    const grid = await screen.findByRole('grid')
    expect(grid).toHaveTextContent('name')
    expect(screen.getByRole('gridcell', { name: 'An' })).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Preview' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    // Sorting, filtering and another delimiter are only a view
    fireEvent.click(screen.getByRole('button', { name: 'age' }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'a' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Delimiter' }), {
      target: { value: ';' },
    })
    expect(mockSave).not.toHaveBeenCalled()
    expect(mockContent).toHaveBeenCalledTimes(1)

    fireEvent.click(toggle)
    expect(await screen.findByTestId('code-block')).toHaveTextContent(
      'name,age',
    )
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    const saved = JSON.parse(localStorage.getItem('termote-settings') ?? '{}')
    expect(saved.tablePreview).toBe(false)
    // Markdown keeps its own choice
    expect(saved.markdownPreview).toBe(true)

    p.unmount()
    show({ path: 'data/a.csv' })
    expect(await screen.findByTestId('code-block')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('grid')).toBeInTheDocument()
  })

  it('shows a large CSV as a table too', async () => {
    mockContent.mockResolvedValue({
      ...csv('a,b\n1,2\n', 'x.tsv'),
      size: 600 * 1024,
    })
    show({ path: 'x.tsv' })
    expect(await screen.findByRole('grid')).toBeInTheDocument()
    expect(screen.queryByText(/Too large/)).toBeNull()
  })

  it('shows the source of a CSV whose quotes never close', async () => {
    mockContent.mockResolvedValue(csv('a,b\n"open,c\n'))
    show({ path: 'data/a.csv' })
    expect(
      await screen.findByText('Unclosed quote on line 2: shown as source'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('code-block')).toHaveTextContent('"open')
  })

  it('a CSV shown as its source is edited as its source', async () => {
    mockContent.mockResolvedValue({
      ...csv('a,b\n'),
      hash: 'h',
      editable: true,
    })
    show({ path: 'data/a.csv', canEdit: true })
    await screen.findByRole('grid')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByTestId('code-block')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('textbox')).toHaveValue('a,b\n')
    expect(screen.queryByRole('grid')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
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
      { paneId: '%1' },
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
    // The dialog opens in an effect after the message renders.
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
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
      new RequestError(409, '', 'root changed', { root: '/new' }),
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

describe('FileViewer: documents', () => {
  beforeEach(() => {
    mockDocument.mockReset()
    mockDocument.mockResolvedValue(new Blob(['%PDF-1.7']))
  })

  it('reads a PDF through files/document, never as text', async () => {
    show({ path: 'docs/spec.PDF', canEdit: true })
    // Its size once read; the viewer in its place
    expect(await screen.findAllByText('8 B')).not.toHaveLength(0)
    expect(mockContent).not.toHaveBeenCalled()
    expect(mockDocument).toHaveBeenCalledWith(
      { paneId: '%1' },
      'docs/spec.PDF',
      expect.objectContaining({ root: '/r', reveal: false }),
      expect.any(AbortSignal),
    )
    expect(await screen.findByTestId('pdf')).toHaveTextContent('docs/spec.PDF')
    expect(screen.queryByText(/Not previewable/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Wrap lines' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('says why a document cannot be shown, with its size and Download', async () => {
    mockDocument.mockRejectedValueOnce(
      new RequestError(413, 'too_large', 'big', { size: 40 << 20 }),
    )
    const onDownload = vi.fn()
    show({ path: 'big.xlsx', onDownload })
    expect(
      await screen.findByText('Larger than 30 MiB (40.0 MiB)'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Download' })[1])
    expect(onDownload).toHaveBeenCalledWith({ revealed: false })
  })

  it('retries a busy server, without Download for a view-only device', async () => {
    mockDocument.mockRejectedValueOnce(new RequestError(429, 'busy', 'busy'))
    show({ path: 'memo.docx' })
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(mockDocument).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
  })

  it('asks before showing a sensitive document, then reads it revealed', async () => {
    mockDocument.mockRejectedValueOnce(
      new RequestError(403, 'sensitive', 'sensitive'),
    )
    show({ path: 'secrets.pdf' })
    expect(
      await screen.findByText('This file may contain secrets'),
    ).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    await waitFor(() =>
      expect(mockDocument.mock.calls[1][2]).toMatchObject({ reveal: true }),
    )
  })
})

// A text file the server would let a save replace
const editable = (text: string, over: Record<string, unknown> = {}) => ({
  root: '/r',
  path: 'src/a.ts',
  size: text.length,
  text,
  hash: `h:${text}`,
  editable: true,
  ...over,
})

const textarea = () => screen.getByRole('textbox', { name: 'Text of src/a.ts' })
const type = (text: string) =>
  fireEvent.change(textarea(), { target: { value: text } })
const saveButton = () => screen.getByRole('button', { name: 'Save' })

async function startEdit(over: Partial<Parameters<typeof FileViewer>[0]> = {}) {
  const p = show({ canEdit: true, ...over })
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  return p
}

describe('FileViewer editing', () => {
  it.each([
    ['a view-only client', editable('x'), { canEdit: false }],
    [
      'a file the server would refuse',
      editable('x', { editable: false, notEditable: 'symlink' }),
      {},
    ],
    [
      'a file it cannot show',
      { root: '/r', path: 'a', size: 1, previewable: false, reason: 'binary' },
      {},
    ],
  ])('offers no Edit for %s', async (_, content, over) => {
    mockContent.mockResolvedValue(content)
    show({ canEdit: true, ...over })
    await waitFor(() => expect(mockContent).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('offers no Edit for an image', async () => {
    mockImage.mockReturnValue(new Promise(() => {}))
    show({ canEdit: true, path: 'a.png' })
    await act(async () => {})
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
  })

  it('saves the text, then shows the file again with its new hash', async () => {
    mockContent.mockResolvedValue(editable('a\nb\n'))
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      size: 4,
      hash: 'h2',
    })
    const onSaved = vi.fn()
    const p = await startEdit({ onSaved })
    expect(textarea()).toHaveValue('a\nb\n')
    expect(screen.queryByRole('button', { name: 'Copy path' })).toBeNull()
    expect(saveButton()).toBeDisabled()
    type('a\nc\n')
    await act(async () => fireEvent.click(saveButton()))
    expect(mockSave).toHaveBeenCalledWith(
      { paneId: '%1' },
      {
        root: '/r',
        path: 'src/a.ts',
        baseHash: 'h:a\nb\n',
        text: 'a\nc\n',
        reveal: false,
      },
    )
    expect(p.notify).toHaveBeenCalledWith('Saved')
    expect(onSaved).toHaveBeenCalled()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByTestId('code-block')).toHaveTextContent('1a2c')
    // Editing again starts from what was saved
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    type('z')
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      size: 1,
      hash: 'h3',
    })
    await act(async () => fireEvent.click(saveButton()))
    expect(mockSave).toHaveBeenLastCalledWith(
      { paneId: '%1' },
      expect.objectContaining({ baseHash: 'h2' }),
    )
  })

  it('a CRLF file is compared with "\\n" line breaks, and shown with CRLF after', async () => {
    mockContent.mockResolvedValue(editable('a\r\nb\r\n'))
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      size: 6,
      hash: 'h2',
    })
    await startEdit()
    expect(textarea()).toHaveValue('a\nb\n')
    expect(saveButton()).toBeDisabled()
    type('a\nc\n')
    await act(async () =>
      fireEvent.keyDown(textarea(), { key: 's', ctrlKey: true }),
    )
    expect(mockSave).toHaveBeenCalledWith(
      { paneId: '%1' },
      expect.objectContaining({ text: 'a\nc\n' }),
    )
    expect(screen.getByTestId('code-block')).toHaveTextContent(/^1a\s*2c\s*$/)
  })

  it('a previewed Markdown file is edited as its source on a touch screen, with a switch to its preview', async () => {
    mockContent.mockResolvedValue(editable('# T\n', { path: 'r.md' }))
    show({ canEdit: true, path: 'r.md' })
    await screen.findByRole('heading', { name: 'T' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('textbox', { name: 'Text of r.md' })).toHaveValue(
      '# T\n',
    )
    expect(screen.queryByTestId('markdown-preview')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(
      screen.getByRole('button', { name: 'Switch to preview' }),
    ).toBeInTheDocument()
  })

  it('a conflict keeps the text; Reload drops it and reads the file again', async () => {
    mockContent
      .mockResolvedValueOnce(editable('old'))
      .mockResolvedValueOnce(editable('agent'))
    mockSave.mockRejectedValue(new RequestError(409, 'changed', 'changed'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const p = await startEdit()
    type('mine')
    await act(async () => fireEvent.click(saveButton()))
    expect(
      screen.getByText('The file changed on the host since you opened it'),
    ).toBeInTheDocument()
    expect(textarea()).toHaveValue('mine')
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Copy my text' })),
    )
    expect(writeText).toHaveBeenCalledWith('mine')
    expect(p.notify).toHaveBeenLastCalledWith('Text copied')
    // Asked first: the text would be lost
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(screen.getByText('Discard changes?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(textarea()).toHaveValue('mine')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(await screen.findByTestId('code-block')).toHaveTextContent('agent')
    expect(mockContent).toHaveBeenCalledTimes(2)
  })

  it('a copy that fails says so', async () => {
    mockContent.mockResolvedValue(editable('x'))
    mockSave.mockRejectedValue(new RequestError(409, 'changed', 'changed'))
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) },
    })
    const p = await startEdit()
    type('y')
    await act(async () => fireEvent.click(saveButton()))
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Copy my text' })),
    )
    expect(p.notify).toHaveBeenLastCalledWith('Could not copy the text')
  })

  it('a moved root keeps the text and disables Save; Discard hands the root on', async () => {
    mockContent.mockResolvedValue(editable('x'))
    mockSave.mockRejectedValue(
      new RequestError(409, '', 'root changed', { root: '/n' }),
    )
    const p = await startEdit()
    type('y')
    await act(async () => fireEvent.click(saveButton()))
    expect(screen.getByText(/This pane's folder changed/)).toBeInTheDocument()
    expect(p.onRootChanged).not.toHaveBeenCalled()
    expect(saveButton()).toBeDisabled()
    // Ctrl+S does nothing either
    fireEvent.keyDown(textarea(), { key: 's', metaKey: true })
    expect(mockSave).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(p.onRootChanged).toHaveBeenCalledWith('/n')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it.each([
    [
      new Error('offline'),
      'Not sure the file was saved. Saving again is safe.',
    ],
    [
      new RequestError(403, 'permission', 'x'),
      "The server can't write this file",
    ],
    [
      new RequestError(413, 'too_large', 'x'),
      'The file would be larger than 1 MiB',
    ],
    [new RequestError(404, '', 'x'), 'File not found on the host'],
  ])(
    'a failed save (%s) says why and can be tried again',
    async (err, text) => {
      mockContent.mockResolvedValue(editable('x'))
      mockSave.mockRejectedValueOnce(err).mockResolvedValueOnce({
        root: '/r',
        path: 'src/a.ts',
        size: 1,
        hash: 'h',
      })
      const p = await startEdit()
      type('y')
      await act(async () => fireEvent.click(saveButton()))
      expect(screen.getByText(text)).toBeInTheDocument()
      expect(saveButton()).toBeEnabled()
      await act(async () => fireEvent.click(saveButton()))
      expect(p.notify).toHaveBeenCalledWith('Saved')
    },
  )

  it('while saving, Back, Cancel and Save are off and the text is read-only', async () => {
    mockContent.mockResolvedValue(editable('x'))
    let finish!: (v: unknown) => void
    mockSave.mockReturnValue(new Promise((r) => (finish = r)))
    await startEdit()
    type('y')
    fireEvent.click(saveButton())
    expect(screen.getByRole('button', { name: 'Back to files' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Cancel editing' }),
    ).toBeDisabled()
    expect(saveButton()).toBeDisabled()
    expect(textarea()).toHaveAttribute('readonly')
    // A second Ctrl+S while one runs sends nothing
    fireEvent.keyDown(textarea(), { key: 's', ctrlKey: true })
    expect(mockSave).toHaveBeenCalledTimes(1)
    await act(async () =>
      finish({ root: '/r', path: 'src/a.ts', size: 1, hash: 'h' }),
    )
  })

  it('Cancel without changes leaves at once; with changes it asks first', async () => {
    mockContent.mockResolvedValue(editable('x'))
    await startEdit()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    type('y')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    // Keep editing
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(textarea()).toHaveValue('y')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(screen.getByTestId('code-block')).toHaveTextContent('x')
  })

  it('Back with changes asks, then discards and goes back; without, goes at once', async () => {
    mockContent.mockResolvedValue(editable('x'))
    const p = await startEdit()
    type('y')
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    expect(p.onClose).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(p.onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to files' }))
    expect(p.onClose).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('keeps the draft across a remount, and asks before the page unloads', async () => {
    mockContent.mockResolvedValue(editable('x'))
    const p = await startEdit()
    type('draft')
    const ev = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    p.unmount()
    show({ canEdit: true })
    expect(textarea()).toHaveValue('draft')
    expect(saveButton()).toBeEnabled()
  })

  it('reads without a root before one is known', async () => {
    mockContent.mockResolvedValue(editable('x'))
    show({ root: undefined })
    await waitFor(() =>
      expect(mockContent).toHaveBeenCalledWith(
        { paneId: '%1' },
        'src/a.ts',
        expect.objectContaining({ root: undefined }),
      ),
    )
  })

  it('a draft from before the root moved shows the move and is not saved', async () => {
    mockContent.mockResolvedValue(editable('x'))
    const p = await startEdit()
    type('draft')
    p.unmount()
    mockContent.mockResolvedValue(editable('x', { root: '/n' }))
    // The tab keeps the root it was opened under, whose draft it shows
    show({ canEdit: true, root: '/n', draftRoot: '/r' })
    expect(textarea()).toHaveValue('draft')
    expect(screen.getByText(/This pane's folder changed/)).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  it('startEditing opens the editor once the file is read', async () => {
    mockContent.mockResolvedValue(editable('x'))
    show({ canEdit: true, startEditing: true })
    expect(await screen.findByRole('textbox')).toHaveValue('x')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    // Not again after a Cancel
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('a sensitive file shown once (initialReveal) is read and saved with reveal', async () => {
    mockContent.mockResolvedValue(editable('A=1', { path: '.env' }))
    mockSave.mockResolvedValue({ root: '/r', path: '.env', size: 3, hash: 'h' })
    show({
      canEdit: true,
      path: '.env',
      initialReveal: true,
      startEditing: true,
    })
    const box = await screen.findByRole('textbox', { name: 'Text of .env' })
    expect(mockContent).toHaveBeenCalledWith({ paneId: '%1' }, '.env', {
      root: '/r',
      reveal: true,
    })
    fireEvent.change(box, { target: { value: 'A=2' } })
    await act(async () => fireEvent.click(saveButton()))
    expect(mockSave).toHaveBeenCalledWith(
      { paneId: '%1' },
      expect.objectContaining({ reveal: true }),
    )
  })

  it('keeps text selected in the file or its editor for a template, never from a file shown as sensitive', async () => {
    resetPaneSelections()
    const selectIn = (node: Node, from: number, to: number) => {
      const range = document.createRange()
      range.setStart(node, from)
      range.setEnd(node, to)
      const sel = document.getSelection() as Selection
      sel.removeAllRanges()
      sel.addRange(range)
      act(() => {
        document.dispatchEvent(new Event('selectionchange'))
      })
    }
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      size: 5,
      text: 'hello',
    })
    const a = show()
    const code = await screen.findByText('hello')
    selectIn(code.firstChild as Node, 1, 4)
    expect(paneSelection('%1')).toEqual({ text: 'ell', source: 'src/a.ts' })
    a.unmount()

    resetPaneSelections()
    mockContent.mockResolvedValue(editable('A=1', { path: '.env' }))
    show({
      canEdit: true,
      path: '.env',
      initialReveal: true,
      startEditing: true,
    })
    const box = (await screen.findByRole('textbox', {
      name: 'Text of .env',
    })) as HTMLTextAreaElement
    box.setSelectionRange(0, 3)
    fireEvent.select(box)
    selectIn(screen.getByText(/secrets|\.env/).firstChild as Node, 0, 1)
    expect(paneSelection('%1')).toBeNull()
    document.getSelection()?.removeAllRanges()
  })

  it('keeps text selected in the editor', async () => {
    resetPaneSelections()
    mockContent.mockResolvedValue(editable('hello'))
    await startEdit()
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    box.setSelectionRange(0, 2)
    fireEvent.select(box)
    expect(paneSelection('%1')).toEqual({ text: 'he', source: 'src/a.ts' })
  })

  it("editing another file keeps the first file's unsaved changes", async () => {
    mockContent.mockResolvedValue(editable('x'))
    const p = await startEdit()
    type('draft of a')
    p.unmount()
    mockContent.mockResolvedValue(editable('y', { path: 'b.ts' }))
    const b = show({ canEdit: true, path: 'b.ts' })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Text of b.ts' })).toHaveValue(
      'y',
    )
    b.unmount()
    // Each file opens again on its own draft
    mockContent.mockResolvedValue(editable('x'))
    show({ canEdit: true })
    expect(
      screen.getByRole('textbox', { name: 'Text of src/a.ts' }),
    ).toHaveValue('draft of a')
  })

  it('startEditing goes straight into editing beside another file with changes', async () => {
    mockContent.mockResolvedValue(editable('x'))
    const p = await startEdit()
    type('draft of a')
    p.unmount()
    mockContent.mockResolvedValue(editable('y', { path: 'b.ts' }))
    show({ canEdit: true, path: 'b.ts', startEditing: true })
    expect(
      await screen.findByRole('textbox', { name: 'Text of b.ts' }),
    ).toHaveValue('y')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('FileViewer: editing Markdown', () => {
  const mdFile = (text: string) => editable(text, { path: 'r.md' })
  const area = () => screen.getByRole('textbox', { name: 'Text of r.md' })
  const layout = () =>
    (area().closest('[data-layout]') as HTMLElement).dataset.layout
  const saved = () =>
    JSON.parse(localStorage.getItem('termote-settings') ?? '{}')
      .markdownEditLayout
  const edit = async (over: Partial<Parameters<typeof FileViewer>[0]> = {}) => {
    const p = show({ canEdit: true, path: 'r.md', ...over })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    // The desktop editor loads in a chunk of its own
    await screen.findByRole('textbox', { name: 'Text of r.md' })
    return p
  }
  beforeEach(() => {
    pointer.fine = true
    pointer.width = 1000
  })
  afterEach(() => {
    pointer.fine = false
    pointer.width = 0
  })

  it('edits beside a preview of the draft, which follows the typing', async () => {
    mockContent.mockResolvedValue(mdFile('# Old\n'))
    await edit()
    expect(layout()).toBe('split')
    const preview = await screen.findByTestId('markdown-preview')
    expect(within(preview).getByRole('heading', { name: 'Old' })).toBeVisible()
    fireEvent.change(area(), { target: { value: '# New\n' } })
    expect(
      await within(preview).findByRole('heading', { name: 'New' }),
    ).toBeInTheDocument()
    expect(saved()).toBeUndefined()
  })

  it('never parses the draft again while it is being typed', async () => {
    mockContent.mockResolvedValue(mdFile('# Old\n'))
    await edit()
    const preview = await screen.findByTestId('markdown-preview')
    await within(preview).findByRole('heading', { name: 'Old' })
    const before = parses.n
    for (const t of ['# N', '# Ne', '# New'])
      fireEvent.change(area(), { target: { value: `${t}\n` } })
    expect(parses.n).toBe(before)
    await within(preview).findByRole('heading', { name: 'New' })
    expect(parses.n).toBe(before + 1)
  })

  it('cycles source and preview, preview alone, and source, remembered on this device', async () => {
    mockContent.mockResolvedValue(mdFile('# T\n'))
    const p = await edit()
    const editor = area()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to preview' }))
    expect(layout()).toBe('preview')
    expect(saved()).toBe('preview')
    // Kept, hidden: the same textarea comes back
    expect(editor.closest('.hidden')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to source' }))
    expect(area()).toBe(editor)
    expect(layout()).toBe('source')
    expect(screen.queryByTestId('markdown-preview')).toBeNull()
    fireEvent.click(
      screen.getByRole('button', { name: 'Switch to source and preview' }),
    )
    expect(layout()).toBe('split')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to preview' }))

    // Opened again: still the preview alone
    p.unmount()
    resetFilesStores()
    await edit()
    expect(layout()).toBe('preview')
  })

  it.each([
    ['a touch screen', { fine: false, width: 1000 }],
    ['a viewer narrower than 768px (a side panel)', { fine: true, width: 767 }],
  ])('on %s, switches between source and preview only', async (_, at) => {
    Object.assign(pointer, at)
    mockContent.mockResolvedValue(mdFile('# T\n'))
    await edit()
    // Split chosen (the default) shows as the source, left as chosen
    expect(layout()).toBe('source')
    expect(screen.queryByTestId('markdown-preview')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to preview' }))
    expect(layout()).toBe('preview')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to source' }))
    expect(layout()).toBe('source')
    expect(saved()).toBe('source')
  })

  it('offers the layouts as a choice in the menu of a narrow header', async () => {
    pointer.width = 440
    mockContent.mockResolvedValue(mdFile('# T\n'))
    await edit({ compact: true })
    expect(
      screen.queryByRole('button', { name: 'Switch to preview' }),
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    const group = screen.getByRole('group', { name: 'Show' })
    const radios = within(group).getAllByRole('menuitemradio')
    expect(radios.map((r) => r.textContent)).toEqual(['Source', 'Preview'])
    expect(radios[0]).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Wrap lines' }))
    fireEvent.click(radios[1])
    expect(layout()).toBe('preview')
    expect(saved()).toBe('preview')
  })

  it('offers all three in the menu when there is room', async () => {
    mockContent.mockResolvedValue(mdFile('# T\n'))
    await edit({ compact: true })
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(
      screen.getAllByRole('menuitemradio').map((r) => r.textContent),
    ).toEqual(['Source', 'Source and preview', 'Preview'])
  })

  it('Ctrl+S saves while the preview shows alone, its banners still there', async () => {
    mockContent.mockResolvedValue(mdFile('a'))
    mockSave.mockRejectedValue(new RequestError(409, 'changed', 'changed'))
    await edit()
    fireEvent.change(area(), { target: { value: 'b' } })
    fireEvent.click(screen.getByRole('button', { name: 'Switch to preview' }))
    // A key outside the viewer is not its own
    const outside = document.createElement('input')
    document.body.append(outside)
    fireEvent.keyDown(outside, { key: 's', ctrlKey: true })
    outside.remove()
    // Another key, or one some other handler took, does nothing
    fireEvent.keyDown(document.body, { key: 'a', ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 's' })
    const taken = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    taken.preventDefault()
    document.body.dispatchEvent(taken)
    expect(mockSave).not.toHaveBeenCalled()
    await act(async () =>
      fireEvent.keyDown(screen.getByTestId('markdown-preview'), {
        key: 's',
        metaKey: true,
      }),
    )
    expect(mockSave).toHaveBeenCalledWith(
      { paneId: '%1' },
      expect.objectContaining({ text: 'b' }),
    )
    expect(
      screen.getByText('The file changed on the host since you opened it'),
    ).toBeInTheDocument()
    // After a conflict the draft is still there to save
    await act(async () =>
      fireEvent.keyDown(document.body, { key: 's', ctrlKey: true }),
    )
    expect(mockSave).toHaveBeenCalledTimes(2)
  })

  it('Ctrl+S in the preview saves only what can be saved', async () => {
    mockContent.mockResolvedValue(mdFile('a'))
    mockSave.mockReturnValue(new Promise(() => {}))
    await edit()
    const key = () =>
      fireEvent.keyDown(screen.getByTestId('markdown-preview'), {
        key: 's',
        ctrlKey: true,
      })
    await screen.findByTestId('markdown-preview')
    // Nothing changed yet
    key()
    expect(mockSave).not.toHaveBeenCalled()
    fireEvent.change(area(), { target: { value: 'b' } })
    await act(async () => key())
    // One save at a time
    await act(async () => key())
    expect(mockSave).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+S never saves a draft of a root that moved', async () => {
    mockContent.mockResolvedValue(mdFile('a'))
    const p = await edit()
    fireEvent.change(area(), { target: { value: 'b' } })
    p.rerender(
      <ThemeProvider>
        <FileViewer {...p} root="/other" draftRoot="/r" />
      </ThemeProvider>,
    )
    fireEvent.keyDown(await screen.findByTestId('markdown-preview'), {
      key: 's',
      ctrlKey: true,
    })
    expect(mockSave).not.toHaveBeenCalled()
  })

  it('a draft past the preview limit shows as its source, until it is back under', async () => {
    mockContent.mockResolvedValue(mdFile('# T\n'))
    await edit()
    const editor = area()
    fireEvent.change(editor, {
      target: { value: 'x'.repeat(PREVIEW_MAX_BYTES + 1) },
    })
    expect(layout()).toBe('source')
    expect(
      screen.getByText('Too large to preview: shown as source'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Switch to preview' }),
    ).toBeNull()
    fireEvent.change(editor, { target: { value: '# T\n' } })
    expect(area()).toBe(editor)
    expect(layout()).toBe('split')
    expect(screen.queryByText(/Too large/)).toBeNull()
  })

  it('previews a long draft too, a little later', async () => {
    mockContent.mockResolvedValue(mdFile('# T\n'))
    await edit()
    const preview = await screen.findByTestId('markdown-preview')
    fireEvent.change(area(), {
      // One line: the editor stand-in is an input
      target: { value: `# Long ${'x'.repeat(70_000)}` },
    })
    expect(
      await within(preview).findByRole(
        'heading',
        { name: /^Long x/ },
        { timeout: 5000 },
      ),
    ).toBeInTheDocument()
  })

  it('says nothing of the limit where the layout chosen does not show', async () => {
    pointer.width = 440
    mockContent.mockResolvedValue(mdFile('# T\n'))
    await edit()
    fireEvent.change(area(), {
      target: { value: 'x'.repeat(PREVIEW_MAX_BYTES + 1) },
    })
    expect(screen.queryByText(/Too large/)).toBeNull()
  })

  it('says nothing of the limit when the source alone was chosen', async () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ markdownEditLayout: 'source' }),
    )
    mockContent.mockResolvedValue(mdFile('# T\n'))
    await edit()
    fireEvent.change(area(), {
      target: { value: 'x'.repeat(PREVIEW_MAX_BYTES + 1) },
    })
    expect(screen.queryByText(/Too large/)).toBeNull()
  })

  it('a link followed from the preview leaves the file where the editor was', async () => {
    mockContent.mockResolvedValue(mdFile('[b](b.md)\n'))
    const p = await edit()
    const editor = area()
    editor.scrollTop = 120
    fireEvent.scroll(editor)
    const preview = await screen.findByTestId('markdown-preview')
    preview.scrollTop = 30
    // The preview's own scroll is not the file's
    fireEvent.scroll(preview)
    fireEvent.click(within(preview).getByRole('button', { name: 'b' }))
    expect(p.onFollow).toHaveBeenCalledWith(
      { kind: 'path', path: 'b.md', anchor: undefined },
      120,
      { newTab: false },
    )
  })

  it('tells what the preview of the draft reports', async () => {
    mockContent.mockResolvedValue(mdFile('```sh\nls\n```\n'))
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const p = await edit()
    const preview = await screen.findByTestId('markdown-preview')
    await act(async () =>
      fireEvent.click(
        within(preview).getByRole('button', { name: 'Copy code' }),
      ),
    )
    expect(writeText).toHaveBeenCalledWith('ls')
    expect(p.notify).toHaveBeenCalledWith('Code copied')
  })

  it('a link followed before the editor scrolled leaves it at the top', async () => {
    mockContent.mockResolvedValue(mdFile('[b](b.md)\n'))
    const p = await edit()
    const preview = await screen.findByTestId('markdown-preview')
    fireEvent.click(within(preview).getByRole('button', { name: 'b' }))
    expect(p.onFollow).toHaveBeenCalledWith(expect.anything(), 0, {
      newTab: false,
    })
  })

  it('scrolls the editor with the preview side by side only', async () => {
    const el = document.createElement('div')
    const side = { el, topLine: () => 1, scrollToLine: vi.fn() }
    sync.side = side
    mockContent.mockResolvedValue(mdFile('# A\n\ntext\n'))
    const p = await edit()
    const preview = await screen.findByTestId('markdown-preview')
    const frame = () =>
      act(
        () => new Promise<void>((done) => requestAnimationFrame(() => done())),
      )
    preview.scrollTop = 30
    fireEvent.scroll(preview)
    await frame()
    expect(side.scrollToLine).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to preview' }))
    fireEvent.scroll(preview)
    await frame()
    expect(side.scrollToLine).toHaveBeenCalledTimes(1)
    p.unmount()
    sync.side = undefined
  })

  it('from the preview alone to side by side, the editor goes to where the preview was read', async () => {
    const el = document.createElement('div')
    const side = { el, topLine: () => 1, scrollToLine: vi.fn() }
    sync.side = side
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ markdownEditLayout: 'preview' }),
    )
    mockContent.mockResolvedValue(mdFile('# A\n'))
    const p = await edit({ compact: true })
    const preview = await screen.findByTestId('markdown-preview')
    const set = vi.spyOn(preview, 'scrollTop', 'set')
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(
      screen.getByRole('menuitemradio', { name: 'Source and preview' }),
    )
    expect(side.scrollToLine).toHaveBeenCalledTimes(1)
    expect(set).not.toHaveBeenCalled()
    p.unmount()
    sync.side = undefined
  })

  it('hides the desktop editor with the preview alone, never unmounting it', async () => {
    pointer.fine = true
    mockContent.mockResolvedValue(mdFile('# T\n'))
    await edit()
    const editor = await screen.findByTestId('code-editor')
    expect(editor).toHaveAttribute('data-hidden', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Switch to preview' }))
    expect(screen.getByTestId('code-editor')).toBe(editor)
    expect(editor).toHaveAttribute('data-hidden', 'true')
  })

  it('a file of another kind is edited without a layout', async () => {
    mockContent.mockResolvedValue(editable('x'))
    await startEdit()
    expect(textarea().closest('[data-layout]')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Switch to / })).toBeNull()
  })
})

describe('FileViewer: pasting an image into Markdown', () => {
  const PH = /!\[Uploading [0-9a-f]{8}…\]\(\)/
  const mdFile = (text: string) => editable(text, { path: 'docs/r.md' })
  const area = () =>
    screen.getByRole('textbox', {
      name: 'Text of docs/r.md',
    }) as HTMLTextAreaElement
  const image = () => new File(['x'], 'shot.png', { type: 'image/png' })
  const paste = (el: HTMLElement = area()) =>
    fireEvent.paste(el, {
      clipboardData: {
        types: ['Files'],
        items: [{ kind: 'file', type: 'image/png', getAsFile: image }],
      },
    })
  // Pasted, and its upload started (after the ones before it)
  const pasted = async (el?: HTMLElement) => {
    paste(el)
    await act(async () => {})
  }
  // An upload answered from the test
  function pending() {
    let answer: (v: unknown) => void = () => {}
    mockPasteUpload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    return (v: unknown) => act(async () => answer(v))
  }
  const saved = (path: string) => ({ ok: true, root: '/r', path })
  const edit = async (over: Partial<Parameters<typeof FileViewer>[0]> = {}) => {
    const p = show({ canEdit: true, path: 'docs/r.md', ...over })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByRole('textbox', { name: 'Text of docs/r.md' })
    return p
  }
  beforeEach(() => mockPasteUpload.mockReset())
  afterEach(() => {
    pointer.fine = false
    pointer.width = 0
  })

  it('puts a placeholder at the cursor, saves the image next to the file, then links it', async () => {
    mockContent.mockResolvedValue(mdFile('ab'))
    const answer = pending()
    await edit()
    area().setSelectionRange(1, 1)
    await pasted()
    expect(area().value).toMatch(new RegExp(`^a${PH.source}b$`))
    expect(mockPasteUpload).toHaveBeenCalledWith(
      { paneId: '%1' },
      { root: '/r', dir: 'docs', reveal: false },
      expect.any(File),
    )
    await answer(saved('docs/assets/pasted-1.png'))
    expect(area()).toHaveValue('a![pasted-1](assets/pasted-1.png)b')
  })

  it('takes the placeholder out and says why when the image is refused', async () => {
    mockContent.mockResolvedValue(mdFile('ab'))
    const answer = pending()
    const p = await edit()
    await pasted()
    await answer({ ok: false, reason: 'sensitive' })
    expect(area()).toHaveValue('ab')
    expect(p.notify).toHaveBeenCalledWith(
      'This folder may hold secrets: the image was not saved',
    )
  })

  it('a placeholder undone, or a draft discarded, gets no link: the user is told where the image is', async () => {
    mockContent.mockResolvedValue(mdFile('ab'))
    let answer = pending()
    const p = await edit()
    await pasted()
    fireEvent.change(area(), { target: { value: 'ab' } })
    await answer(saved('docs/pasted-1.png'))
    expect(area()).toHaveValue('ab')
    expect(p.notify).toHaveBeenCalledWith('Image saved as docs/pasted-1.png')

    answer = pending()
    await pasted()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await answer(saved('docs/pasted-2.png'))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(p.notify).toHaveBeenLastCalledWith(
      'Image saved as docs/pasted-2.png',
    )
  })

  it('saves pasted images one after another', async () => {
    mockContent.mockResolvedValue(mdFile(''))
    const first = pending()
    const second = pending()
    await edit()
    await pasted()
    await pasted()
    expect(mockPasteUpload).toHaveBeenCalledTimes(1)
    await first(saved('docs/a.png'))
    expect(mockPasteUpload).toHaveBeenCalledTimes(2)
    await second(saved('docs/b.png'))
    expect(area()).toHaveValue('![a](a.png)![b](b.png)')
  })

  it('a save while the image uploads keeps the placeholder, valid Markdown', async () => {
    mockContent.mockResolvedValue(mdFile('x'))
    mockSave.mockReturnValue(new Promise(() => {}))
    pending()
    await edit()
    await pasted()
    await act(async () =>
      fireEvent.keyDown(area(), { key: 's', ctrlKey: true }),
    )
    expect(mockSave.mock.calls[0][1].text).toMatch(PH)
  })

  it('links the image even when the editor hid meanwhile', async () => {
    pointer.fine = true
    pointer.width = 1000
    mockContent.mockResolvedValue(mdFile('a'))
    const answer = pending()
    await edit()
    await pasted()
    fireEvent.click(screen.getByRole('button', { name: 'Switch to preview' }))
    await answer(saved('docs/p.png'))
    fireEvent.click(screen.getByRole('button', { name: 'Switch to source' }))
    expect(area()).toHaveValue('a![p](p.png)')
  })

  it('refuses a HEIC or a large image at once, without a placeholder', async () => {
    mockContent.mockResolvedValue(mdFile('ab'))
    const p = await edit()
    fireEvent.paste(area(), {
      clipboardData: {
        types: ['Files'],
        items: [
          {
            kind: 'file',
            type: 'image/heic',
            getAsFile: () => new File(['x'], 'p', { type: 'image/heic' }),
          },
        ],
      },
    })
    expect(area()).toHaveValue('ab')
    expect(mockPasteUpload).not.toHaveBeenCalled()
    expect(p.notify).toHaveBeenCalledWith(
      'HEIC images are not supported. Share the photo as JPEG',
    )
  })

  it('a root that moved says so where saving would', async () => {
    mockContent.mockResolvedValue(mdFile('ab'))
    const answer = pending()
    const p = await edit()
    await pasted()
    await answer({ ok: false, reason: 'root_changed', root: '/new' })
    expect(area()).toHaveValue('ab')
    expect(
      screen.getByText(/This pane's folder changed. Copy your text/),
    ).toBeInTheDocument()
    expect(p.notify).toHaveBeenCalledWith(
      "This pane's folder changed: the image was not saved",
    )
  })

  it('an upload that breaks takes its placeholder out, and the next one still goes', async () => {
    mockContent.mockResolvedValue(mdFile('ab'))
    mockPasteUpload.mockRejectedValueOnce(new Error('boom'))
    const answer = pending()
    const p = await edit()
    await pasted()
    expect(area()).toHaveValue('ab')
    expect(p.notify).toHaveBeenCalledWith('Could not save the image')
    await pasted()
    await answer(saved('docs/q.png'))
    expect(area().value).toContain('![q](q.png)')
    expect(area().value).not.toMatch(PH)
  })

  it('an image whose placeholder a save wrote says the file still holds it', async () => {
    mockContent.mockResolvedValue(mdFile('x'))
    mockSave.mockResolvedValue({ root: '/r', size: 1, hash: 'h2' })
    const answer = pending()
    const p = await edit()
    await pasted()
    await act(async () =>
      fireEvent.keyDown(area(), { key: 's', ctrlKey: true }),
    )
    // Saved as it was: the draft is done with
    expect(screen.queryByRole('textbox')).toBeNull()
    await answer(saved('docs/p.png'))
    expect(p.notify).toHaveBeenLastCalledWith(
      'Image saved as docs/p.png. The file still holds its placeholder',
    )
  })

  it('leaves the paste to the editor for another kind of file', async () => {
    mockContent.mockResolvedValue(editable('x'))
    await startEdit()
    await pasted(textarea())
    expect(mockPasteUpload).not.toHaveBeenCalled()
  })

  it('leaves the paste to the editor once the root moved', async () => {
    mockContent.mockResolvedValue(mdFile('x'))
    const p = await edit()
    p.rerender(
      <ThemeProvider>
        <FileViewer {...p} root="/other" draftRoot="/r" />
      </ThemeProvider>,
    )
    await pasted()
    expect(mockPasteUpload).not.toHaveBeenCalled()
  })
})

describe('FileViewer in a tab', () => {
  it('a preview tab offers Keep open; editing pins it too', async () => {
    mockContent.mockResolvedValue(editable('x'))
    const onPin = vi.fn()
    show({ canEdit: true, pinned: false, onPin })
    fireEvent.click(await screen.findByRole('button', { name: 'Keep open' }))
    expect(onPin).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(onPin).toHaveBeenCalledTimes(2)
  })

  it('a pinned tab has no Keep open', async () => {
    mockContent.mockResolvedValue(editable('x'))
    show({ onPin: vi.fn() })
    await screen.findByTestId('code-block')
    expect(screen.queryByRole('button', { name: 'Keep open' })).toBeNull()
  })

  it('tells the tab once a sensitive file is shown, or declined', async () => {
    mockContent
      .mockResolvedValueOnce({ root: '/r', path: '.env', sensitive: true })
      .mockResolvedValueOnce({ root: '/r', path: '.env', size: 5, text: 'A=1' })
    const onRevealed = vi.fn()
    show({ path: '.env', onRevealed })
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    expect(onRevealed).toHaveBeenCalled()
    cleanup()
    mockContent.mockResolvedValue({ root: '/r', path: '.env', sensitive: true })
    const onCancelReveal = vi.fn()
    const p = show({ path: '.env', onCancelReveal })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(onCancelReveal).toHaveBeenCalled()
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('a file gone from the host offers to close its tab', async () => {
    mockContent.mockRejectedValue(new RequestError(404, '', 'x'))
    const onCloseTab = vi.fn()
    show({ onCloseTab })
    fireEvent.click(await screen.findByRole('button', { name: 'Close tab' }))
    expect(onCloseTab).toHaveBeenCalled()
    cleanup()
    // Another error: nothing to close for
    mockContent.mockRejectedValue(new RequestError(403, '', 'x'))
    show({ onCloseTab })
    await screen.findByText("This file can't be shown")
    expect(screen.queryByRole('button', { name: 'Close tab' })).toBeNull()
  })

  it('tells the tab whether its file was found', async () => {
    mockContent.mockRejectedValue(new RequestError(404, '', 'x'))
    const gone = vi.fn()
    show({ onMissingChange: gone })
    await waitFor(() => expect(gone).toHaveBeenCalledWith(true))
    cleanup()
    // Another error says nothing
    mockContent.mockRejectedValue(new RequestError(403, '', 'x'))
    const other = vi.fn()
    show({ onMissingChange: other })
    await screen.findByText("This file can't be shown")
    expect(other).not.toHaveBeenCalled()
    cleanup()
    mockContent.mockResolvedValue(editable('x'))
    const found = vi.fn()
    show({ onMissingChange: found })
    await screen.findByTestId('code-block')
    expect(found).toHaveBeenCalledWith(false)
  })

  it('reports where the text is scrolled, and starts there again', async () => {
    mockContent.mockResolvedValue(editable('x\ny'))
    const onScroll = vi.fn()
    show({ canEdit: true, onScroll, scrollTop: 30 })
    const code = await screen.findByTestId('code-block')
    expect(code.scrollTop).toBe(30)
    code.scrollTop = 55
    fireEvent.scroll(code)
    expect(onScroll).toHaveBeenLastCalledWith(55)
    // The editor starts where the source was left
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(textarea().scrollTop).toBe(55)
    textarea().scrollTop = 12
    fireEvent.scroll(textarea())
    expect(onScroll).toHaveBeenLastCalledWith(12)
    // A scroll of anything else is not the text's
    onScroll.mockClear()
    fireEvent.scroll(screen.getByRole('button', { name: 'Save' }))
    expect(onScroll).not.toHaveBeenCalled()
  })

  it('switching between preview and source starts at the top', async () => {
    mockContent.mockResolvedValue(editable('# A', { path: 'a.md' }))
    show({ path: 'a.md', scrollTop: 40 })
    const preview = await screen.findByTestId('markdown-preview')
    expect(preview.scrollTop).toBe(40)
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByTestId('code-block').scrollTop).toBe(0)
  })

  it('on a narrow screen keeps the main buttons and puts the rest in a menu', async () => {
    mockContent.mockResolvedValue(editable('# A', { path: 'a.md' }))
    const onPin = vi.fn()
    const onDelete = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    show({
      path: 'a.md',
      compact: true,
      canEdit: true,
      pinned: false,
      onPin,
      onDelete,
      headerExtra: <button type="button">extra</button>,
    })
    await screen.findByTestId('markdown-preview')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'extra' })).toBeInTheDocument()
    for (const name of [
      'Keep open',
      'Delete',
      'Copy path',
      'Preview',
      'Wrap lines',
    ])
      expect(screen.queryByRole('button', { name })).toBeNull()
    const more = () =>
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    more()
    const menu = screen.getByRole('menu')
    expect(
      [...menu.querySelectorAll('[role^="menuitem"]')].map(
        (i) => i.textContent,
      ),
    ).toEqual(['Keep open', 'Delete', 'Copy path', 'Preview', 'Wrap lines'])
    expect(
      within(menu).getByRole('menuitemcheckbox', { name: 'Preview' }),
    ).toHaveAttribute('aria-checked', 'true')
    expect(
      within(menu).getByRole('menuitemcheckbox', { name: 'Wrap lines' }),
    ).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Keep open' }))
    expect(onPin).toHaveBeenCalled()
    more()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(onDelete).toHaveBeenCalledWith({ hash: 'h:# A', sensitive: false })
    more()
    await act(async () =>
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' })),
    )
    expect(writeText).toHaveBeenCalledWith('a.md')
    more()
    fireEvent.click(
      screen.getByRole('menuitemcheckbox', { name: 'Wrap lines' }),
    )
    more()
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Wrap lines' }),
    ).toHaveAttribute('aria-checked', 'true')
    // Preview off: the source shows
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Preview' }))
    expect(await screen.findByTestId('code-block')).toBeInTheDocument()
  })

  it('offers no empty More actions menu', () => {
    render(<HeaderActions actions={[]} compact />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('an SVG on a narrow screen switches to its image from the menu', async () => {
    mockContent.mockResolvedValue(editable('<svg/>', { path: 'a.svg' }))
    show({ path: 'a.svg', compact: true })
    await screen.findByTestId('code-block')
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Image' }))
    expect(
      JSON.parse(localStorage.getItem('termote-settings') ?? '{}'),
    ).toMatchObject({
      svgPreview: true,
    })
  })

  it('shows more buttons at the end of the header', async () => {
    mockContent.mockResolvedValue(editable('x'))
    show({ headerExtra: <button type="button">extra</button> })
    expect(
      await screen.findByRole('button', { name: 'extra' }),
    ).toBeInTheDocument()
  })
})

describe('FileViewer: a click on a cell of a table viewed', () => {
  const csvFile = (text: string) => editable(text, { path: 'd.csv' })
  const field = (name: string) => screen.getByRole('textbox', { name })

  beforeEach(() => {
    pointer.fine = true
  })
  afterEach(() => {
    pointer.fine = false
  })

  it('starts editing, pins the tab and edits that cell where it is', async () => {
    mockContent.mockResolvedValue(csvFile('name,price\r\npear,2\r\n'))
    const onPin = vi.fn()
    show({ canEdit: true, path: 'd.csv', pinned: false, onPin })
    await screen.findByRole('grid')
    fireEvent.click(screen.getByRole('gridcell', { name: '2' }))
    expect(onPin).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    const box = field('Edit price, row 2')
    expect(box).toHaveValue('2')
    fireEvent.change(box, { target: { value: '2.5' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(screen.getByRole('gridcell', { name: '2.5' })).toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
    // Escape on a field left as it was stays in editing
    fireEvent.click(screen.getByRole('gridcell', { name: 'pear' }))
    fireEvent.keyDown(field('Edit name, row 2'), { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('asks first about another delimiter, then opens no cell', async () => {
    mockContent.mockResolvedValue(csvFile('a,b;c\n1,2;3\n'))
    show({ canEdit: true, path: 'd.csv' })
    await screen.findByRole('grid')
    fireEvent.change(screen.getByRole('combobox', { name: 'Delimiter' }), {
      target: { value: ';' },
    })
    fireEvent.click(screen.getByRole('gridcell', { name: '3' }))
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Edit with another delimiter?',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit anyway' }))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /^Edit / })).toBeNull()
  })

  it('a file that cannot be edited shows the cell in its sheet', async () => {
    mockContent.mockResolvedValue(csvFile('a\n1\n'))
    show({ path: 'd.csv' })
    await screen.findByRole('grid')
    fireEvent.click(screen.getByRole('gridcell', { name: '1' }))
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(screen.getByRole('dialog')).toHaveTextContent('1')
  })

  it('a coarse pointer shows the cell in its sheet, still viewing', async () => {
    pointer.fine = false
    mockContent.mockResolvedValue(csvFile('a\n1\n'))
    show({ canEdit: true, path: 'd.csv' })
    await screen.findByRole('grid')
    fireEvent.click(screen.getByRole('gridcell', { name: '1' }))
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(screen.getByRole('dialog')).toHaveTextContent('1')
  })
})

describe('FileViewer: editing a table', () => {
  const csvFile = (text: string, over: Record<string, unknown> = {}) =>
    editable(text, { path: 'd.csv', ...over })
  const grid = () => screen.getByRole('grid')
  const valueBox = () => screen.getByRole('textbox', { name: 'Value' })
  // Sets one cell through its sheet
  const setCell = (shown: string, value: string) => {
    fireEvent.click(screen.getByRole('gridcell', { name: shown }))
    fireEvent.change(valueBox(), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
  }
  async function editTable(
    over: Partial<Parameters<typeof FileViewer>[0]> = {},
  ) {
    const p = show({ canEdit: true, path: 'd.csv', ...over })
    await screen.findByRole('grid')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    return p
  }
  const changed = () => new RequestError(409, 'changed', 'changed')

  it('edits the table being viewed and saves only the cell changed', async () => {
    const text = '﻿name,price\r\npear,2\r\nplum,3\r\n'
    mockContent.mockResolvedValue(csvFile(text))
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'd.csv',
      size: 1,
      hash: 'h2',
    })
    const onSaved = vi.fn()
    const p = await editTable({ onSaved })
    expect(grid()).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /Text of/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    expect(saveButton()).toBeDisabled()
    setCell('2', '2.5')
    // Ctrl+S on the table saves it
    await act(async () =>
      fireEvent.keyDown(grid(), { key: 's', ctrlKey: true }),
    )
    // The draft's "\n" text, with only the cell's characters changed; the
    // server writes "\r\n" back
    expect(mockSave).toHaveBeenCalledWith(
      { paneId: '%1' },
      {
        root: '/r',
        path: 'd.csv',
        baseHash: `h:${text}`,
        text: '﻿name,price\npear,2.5\nplum,3\n',
        reveal: false,
      },
    )
    expect(p.notify).toHaveBeenCalledWith('Saved')
    expect(onSaved).toHaveBeenCalled()
    // Viewed again, with the view's own toolbar
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(screen.getByRole('gridcell', { name: '2.5' })).toBeInTheDocument()
  })

  it('Cancel with edits asks; undone edits leave at once', async () => {
    mockContent.mockResolvedValue(csvFile('a\n1\n'))
    await editTable()
    setCell('1', '2')
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(saveButton()).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    setCell('1', '2')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    expect(screen.getByText('Discard changes?')).toBeInTheDocument()
  })

  it('startEditing (Changes) opens the source, even for a table', async () => {
    mockContent.mockResolvedValue(csvFile('a,b\n'))
    show({ canEdit: true, path: 'd.csv', startEditing: true })
    expect(
      await screen.findByRole('textbox', { name: 'Text of d.csv' }),
    ).toHaveValue('a,b\n')
  })

  it('Edit while the table is still read opens the source', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        postMessage() {}
        terminate() {}
      },
    )
    mockContent.mockResolvedValue({
      ...csvFile(`a,b\n${'1,2\n'.repeat(70000)}`),
    })
    show({ canEdit: true, path: 'd.csv' })
    expect(await screen.findByText('Reading the table…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(
      screen.getByRole('textbox', { name: 'Text of d.csv' }),
    ).toBeInTheDocument()
  })

  it('asks before editing with a delimiter other than the one found', async () => {
    mockContent.mockResolvedValue(csvFile('a,b;c\n1,2;3\n'))
    show({ canEdit: true, path: 'd.csv' })
    await screen.findByRole('grid')
    fireEvent.change(screen.getByRole('combobox', { name: 'Delimiter' }), {
      target: { value: ';' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'This file looks comma-separated, and you are viewing it as semicolon-separated.',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit anyway' }))
    const select = screen.getByRole('combobox', { name: 'Delimiter' })
    expect(select).toHaveValue(';')
    expect(select).toBeDisabled()
    setCell('3', 'x;y')
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'd.csv',
      size: 1,
      hash: 'h',
    })
    await act(async () => fireEvent.click(saveButton()))
    expect(mockSave).toHaveBeenCalledWith(
      { paneId: '%1' },
      expect.objectContaining({ text: 'a,b;c\n1,2;"x;y"\n' }),
    )
  })

  it('another file with unsaved changes is kept: asks only for the delimiter', async () => {
    mockContent.mockResolvedValue(editable('x'))
    const first = await startEdit()
    type('draft of a')
    first.unmount()
    mockContent.mockResolvedValue(csvFile('a,b;c\n1,2;3\n'))
    show({ canEdit: true, path: 'd.csv' })
    await screen.findByRole('grid')
    fireEvent.change(screen.getByRole('combobox', { name: 'Delimiter' }), {
      target: { value: ';' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Edit with another delimiter?',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit anyway' }))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: /Text of/ })).toBeNull()
    const draft = renderHook(() => useFileDraft('%1', '/r', 'd.csv'))
    expect(draft.result.current[0]).toMatchObject({
      path: 'd.csv',
      cells: { delimiter: ';', ops: [], redo: [] },
    })
    const a = renderHook(() => useFileDraft('%1', '/r', 'src/a.ts'))
    expect(a.result.current[0]?.text).toBe('draft of a')
  })

  it('another draft with the delimiter found: straight into the table', async () => {
    mockContent.mockResolvedValue(editable('x'))
    const first = await startEdit()
    type('draft of a')
    first.unmount()
    mockContent.mockResolvedValue(csvFile('a,b\n1,2\n'))
    show({ canEdit: true, path: 'd.csv' })
    await screen.findByRole('grid')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('while saving, the table takes no edit', async () => {
    mockContent.mockResolvedValue(csvFile('a\n1\n'))
    let done: (v: unknown) => void = () => {}
    mockSave.mockReturnValue(new Promise((r) => (done = r)))
    await editTable()
    setCell('1', '2')
    fireEvent.click(saveButton())
    fireEvent.click(screen.getByRole('gridcell', { name: '2' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
    await act(async () =>
      done({ root: '/r', path: 'd.csv', size: 1, hash: 'h2' }),
    )
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it("a save leaves another file's draft alone", async () => {
    mockContent.mockResolvedValue(csvFile('a\n1\n'))
    let done: (v: unknown) => void = () => {}
    mockSave.mockReturnValue(new Promise((r) => (done = r)))
    await editTable()
    setCell('1', '2')
    fireEvent.click(saveButton())
    // Another view of the pane edits another file meanwhile
    const mine = renderHook(() => useFileDraft('%1', '/r', 'd.csv'))
    const other = renderHook(() => useFileDraft('%1', '/r', 'b.ts'))
    const theirs = {
      ...mine.result.current[0],
      path: 'b.ts',
      cells: undefined,
    } as FileDraft
    act(() => other.result.current[1](theirs))
    await act(async () =>
      done({ root: '/r', path: 'd.csv', size: 1, hash: 'h2' }),
    )
    expect(other.result.current[0]).toBe(theirs)
    expect(mine.result.current[0]).toBeUndefined()
  })

  it('a save keeps edits made to the same file meanwhile, on the text saved', async () => {
    mockContent.mockResolvedValue(csvFile('a\n1\n'))
    let done: (v: unknown) => void = () => {}
    mockSave.mockReturnValue(new Promise((r) => (done = r)))
    await editTable()
    setCell('1', '2')
    fireEvent.click(saveButton())
    const other = renderHook(() => useFileDraft('%1', '/r', 'd.csv'))
    const sent = other.result.current[0] as FileDraft
    act(() => other.result.current[1]({ ...sent, text: 'a\n3\n' }))
    await act(async () =>
      done({ root: '/r', path: 'd.csv', size: 1, hash: 'h2' }),
    )
    expect(other.result.current[0]).toMatchObject({
      base: 'a\n2\n',
      baseHash: 'h2',
      text: 'a\n3\n',
      cells: { ops: [] },
    })
  })

  it('a save after the draft was dropped elsewhere leaves none', async () => {
    mockContent.mockResolvedValue(csvFile('a\n1\n'))
    let done: (v: unknown) => void = () => {}
    mockSave.mockReturnValue(new Promise((r) => (done = r)))
    await editTable()
    setCell('1', '2')
    fireEvent.click(saveButton())
    const other = renderHook(() => useFileDraft('%1', '/r', 'd.csv'))
    act(() => other.result.current[1](undefined))
    await act(async () =>
      done({ root: '/r', path: 'd.csv', size: 1, hash: 'h2' }),
    )
    expect(other.result.current[0]).toBeUndefined()
  })

  it('a conflict: Reload and reapply puts each edit on its row in the new file', async () => {
    mockContent.mockResolvedValue(csvFile('name,price\npear,2\nplum,3\n'))
    mockSave.mockRejectedValueOnce(changed())
    const p = await editTable()
    setCell('2', '9')
    await act(async () => fireEvent.click(saveButton()))
    expect(
      screen.getByText('The file changed on the host since you opened it'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Copy my text' })),
    )
    expect(writeText).toHaveBeenCalledWith('name,price\npear,9\nplum,3\n')
    // An agent put a row above pear, with pear's old price, as CRLF
    const agent = 'name,price\r\nkiwi,2\r\npear,2\r\nplum,3\r\n'
    mockContent.mockResolvedValueOnce(csvFile(agent))
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Reload and reapply' }),
      ),
    )
    expect(mockContent).toHaveBeenLastCalledWith({ paneId: '%1' }, 'd.csv', {
      root: '/r',
      reveal: false,
    })
    expect(screen.queryByText(/changed on the host/)).toBeNull()
    const draft = renderHook(() => useFileDraft('%1', '/r', 'd.csv')).result
      .current[0]
    expect(draft).toMatchObject({
      baseHash: `h:${agent}`,
      crlf: true,
      text: 'name,price\nkiwi,2\npear,9\nplum,3\n',
    })
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'd.csv',
      size: 1,
      hash: 'h3',
    })
    await act(async () => fireEvent.click(saveButton()))
    expect(mockSave).toHaveBeenLastCalledWith(
      { paneId: '%1' },
      expect.objectContaining({
        baseHash: `h:${agent}`,
        text: 'name,price\nkiwi,2\npear,9\nplum,3\n',
      }),
    )
    expect(p.notify).toHaveBeenLastCalledWith('Saved')
  })

  it('lists the edits a reload could not apply, with their values to copy', async () => {
    mockContent.mockResolvedValue(csvFile('name,price\npear,2\nplum,3\n'))
    mockSave.mockRejectedValueOnce(changed())
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const p = await editTable()
    setCell('2', '9')
    setCell('3', '8')
    await act(async () => fireEvent.click(saveButton()))
    // pear is gone
    mockContent.mockResolvedValueOnce(csvFile('name,price\nplum,3\n'))
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Reload and reapply' }),
      ),
    )
    expect(screen.getByText(/Not applied to the new file/)).toHaveTextContent(
      'Row 2, column price: its row is no longer in the file',
    )
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Copy value' })),
    )
    expect(writeText).toHaveBeenCalledWith('9')
    expect(p.notify).toHaveBeenLastCalledWith('Text copied')
    expect(screen.getByRole('gridcell', { name: '8' })).toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
    // Discarding forgets the list
    fireEvent.click(screen.getByRole('button', { name: 'Cancel editing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByText(/Not applied/)).toBeNull()
  })

  it.each([
    [
      'is no longer editable',
      csvFile('a,b\n', { editable: false, notEditable: 'mixed-eol' }),
    ],
    ['is no table', csvFile('a,"b\n')],
    ['asks to be shown', { root: '/r', path: 'd.csv', sensitive: true }],
  ])(
    'a reload whose file %s applies nothing and turns Save off',
    async (_, next) => {
      mockContent.mockResolvedValue(csvFile('a,b\n1,2\n'))
      mockSave.mockRejectedValueOnce(changed())
      await editTable()
      setCell('2', 'x')
      fireEvent.click(screen.getByRole('gridcell', { name: '1' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add row below' }))
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      fireEvent.click(
        screen.getByRole('button', { name: 'Add a row at the end' }),
      )
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      fireEvent.click(screen.getByRole('button', { name: 'Header row' }))
      fireEvent.click(screen.getByRole('gridcell', { name: 'a' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add row below' }))
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      fireEvent.click(screen.getByRole('gridcell', { name: 'a' }))
      fireEvent.click(screen.getByRole('button', { name: 'Delete row' }))
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Delete row',
        }),
      )
      await act(async () => fireEvent.click(saveButton()))
      mockContent.mockResolvedValueOnce(next)
      await act(async () =>
        fireEvent.click(
          screen.getByRole('button', { name: 'Reload and reapply' }),
        ),
      )
      const list = screen.getByText(/Not applied to the new file/)
      for (const line of [
        'Row 2, column b: the file can no longer be edited as a table',
        'The row added after row 2: the file',
        'The row added after row 3: the file',
        'The row added after row 1: the file',
        'Deleting row 1: the file',
      ]) {
        expect(list).toHaveTextContent(line)
      }
      expect(saveButton()).toBeDisabled()
      // Ctrl+S is off too
      fireEvent.keyDown(screen.getByRole('grid'), { key: 's', ctrlKey: true })
      expect(mockSave).toHaveBeenCalledTimes(1)
      // The conflict stays, so the reload can be tried again
      expect(screen.getByText(/changed on the host/)).toBeInTheDocument()
    },
    // Many clicks: about 1 s, several on a loaded machine
    15000,
  )

  it('a reload naming the row added at the top', async () => {
    mockContent.mockResolvedValue(csvFile('a\n'))
    mockSave.mockRejectedValueOnce(changed())
    await editTable()
    fireEvent.click(screen.getByRole('button', { name: 'Header row' }))
    fireEvent.click(screen.getByRole('gridcell', { name: 'a' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete row' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Delete row',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Add a row' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await act(async () => fireEvent.click(saveButton()))
    mockContent.mockResolvedValueOnce(csvFile('"a\n'))
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Reload and reapply' }),
      ),
    )
    expect(screen.getByText(/Not applied/)).toHaveTextContent(
      'The row added at the top',
    )
  })

  it('a reload naming column edits it could not apply', async () => {
    mockContent.mockResolvedValue(csvFile('a,b\n1,2\n'))
    mockSave.mockRejectedValueOnce(changed())
    await editTable()
    const header = (name: string) =>
      screen.getByRole('columnheader', { name }) as HTMLElement
    fireEvent.contextMenu(header('a'))
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Insert column right' }),
    )
    // Its name is asked for in the sheet (no fine pointer here): none given
    expect(screen.getByRole('dialog')).toHaveTextContent('Row 1 · Column 2')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.contextMenu(header('b'))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete column' }))
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Delete column',
      }),
    )
    // Header row off: a column op names its number
    fireEvent.click(screen.getByRole('button', { name: 'Header row' }))
    fireEvent.contextMenu(header('Column 2'))
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Insert column left' }),
    )
    await act(async () => fireEvent.click(saveButton()))
    mockContent.mockResolvedValueOnce(csvFile('x,y\n1,2\n'))
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Reload and reapply' }),
      ),
    )
    const list = screen.getByText(/Not applied to the new file/)
    for (const line of [
      'The column added after column "a": its column is no longer in the file',
      'Deleting column "b": it follows a row or column change that was not applied',
      'The column added before column 2: it follows',
    ]) {
      expect(list).toHaveTextContent(line)
    }
  })

  it('a reload naming pasted blocks it could not apply', async () => {
    mockContent.mockResolvedValue(csvFile('a,b\n1,2\n3,4\n'))
    mockSave.mockRejectedValueOnce(changed())
    await editTable()
    const pasteAt = (name: string, text: string) => {
      const cell = screen.getByRole('gridcell', { name })
      cell.focus()
      fireEvent.keyDown(cell, { key: 'v', ctrlKey: true })
      // The paste reaches the hidden field the key gave the focus to
      fireEvent.paste(document.activeElement as Element, {
        clipboardData: { getData: () => text },
      })
    }
    pasteAt('1', 'q')
    // Past the last row: one row added, asked first
    pasteAt('4', 'x\ny')
    fireEvent.click(screen.getByRole('button', { name: 'Add and paste' }))
    await act(async () => fireEvent.click(saveButton()))
    mockContent.mockResolvedValueOnce(csvFile('a,b\n9,9\n'))
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Reload and reapply' }),
      ),
    )
    const list = screen.getByText(/Not applied/)
    expect(list).toHaveTextContent(
      'Pasted block, 1 cell: its row is no longer in the file',
    )
    expect(list).toHaveTextContent(
      'Pasted block, 2 cells: its row is no longer in the file',
    )
  })

  it('a reload keeps a draft another view made meanwhile', async () => {
    mockContent.mockResolvedValue(csvFile('a\n1\n'))
    mockSave.mockRejectedValueOnce(changed())
    await editTable()
    setCell('1', '2')
    await act(async () => fireEvent.click(saveButton()))
    let done: (v: unknown) => void = () => {}
    mockContent.mockReturnValueOnce(new Promise((r) => (done = r)))
    fireEvent.click(screen.getByRole('button', { name: 'Reload and reapply' }))
    // Another view of the pane replaced the draft of this file meanwhile
    const other = renderHook(() => useFileDraft('%1', '/r', 'd.csv'))
    const theirs = {
      ...(other.result.current[0] as FileDraft),
      text: 'a\n5\n',
      cells: undefined,
    }
    act(() => other.result.current[1](theirs))
    await act(async () => done(csvFile('a\n0\n1\n')))
    expect(other.result.current[0]).toBe(theirs)
  })

  it('a reload finding the edits already saved takes the file as it is', async () => {
    mockContent.mockResolvedValue(csvFile('a\n1\n'))
    // Timed out, yet written
    mockSave.mockRejectedValueOnce(new Error('offline'))
    const p = await editTable()
    setCell('1', '2')
    await act(async () => fireEvent.click(saveButton()))
    expect(screen.getByText(/Not sure the file was saved/)).toBeInTheDocument()
    mockSave.mockRejectedValueOnce(changed())
    await act(async () => fireEvent.click(saveButton()))
    mockContent.mockResolvedValueOnce(csvFile('a\n2\n'))
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Reload and reapply' }),
      ),
    )
    expect(p.notify).toHaveBeenLastCalledWith(
      'Your changes are already in the file',
    )
    expect(saveButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
  })

  it('a reload that finds the root moved, or fails, says so', async () => {
    mockContent.mockResolvedValue(csvFile('a\n1\n'))
    mockSave.mockRejectedValue(changed())
    const p = await editTable()
    setCell('1', '2')
    await act(async () => fireEvent.click(saveButton()))
    mockContent.mockRejectedValueOnce(new Error('offline'))
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Reload and reapply' }),
      ),
    )
    expect(p.notify).toHaveBeenLastCalledWith('Could not read the file again')
    expect(screen.getByText(/changed on the host/)).toBeInTheDocument()
    mockContent.mockRejectedValueOnce(
      Object.assign(new RequestError(409, 'moved', ''), { root: '/new' }),
    )
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Reload and reapply' }),
      ),
    )
    expect(screen.getByText(/This pane's folder changed/)).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
  })

  it('a second Reload and reapply while one runs is ignored', async () => {
    mockContent.mockResolvedValue(csvFile('a\n1\n'))
    mockSave.mockRejectedValue(changed())
    await editTable()
    setCell('1', '2')
    await act(async () => fireEvent.click(saveButton()))
    mockContent.mockReturnValueOnce(new Promise(() => {}))
    const reload = screen.getByRole('button', { name: 'Reload and reapply' })
    fireEvent.click(reload)
    fireEvent.click(reload)
    expect(mockContent).toHaveBeenCalledTimes(2)
  })

  it('reapplies a large file here when no worker loads', async () => {
    const rows = 40000
    const big = `id,v\n${Array.from({ length: rows }, (_, i) => `${i},v${i}`).join('\n')}\n`
    mockContent.mockResolvedValue(csvFile('id,v\n0,v0\n'))
    mockSave.mockRejectedValueOnce(changed())
    await editTable()
    setCell('v0', 'w')
    await act(async () => fireEvent.click(saveButton()))
    // No Worker here: CsvClient applies them on this thread
    vi.stubGlobal('Worker', undefined)
    mockContent.mockResolvedValueOnce(csvFile(big))
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Reload and reapply' }),
      ),
    )
    const draft = renderHook(() => useFileDraft('%1', '/r', 'd.csv')).result
      .current[0]
    expect(draft?.text.startsWith('id,v\n0,w\n1,v1\n')).toBe(true)
  })
})

describe('rebaseDraft', () => {
  const base: FileDraft = {
    root: '/r',
    path: 'd.csv',
    baseHash: 'h',
    base: 'a\n1\n',
    crlf: false,
    text: 'a\n2\n',
    reveal: false,
  }
  const op = (n: number) =>
    ({
      kind: 'delete',
      row: n,
      rowValues: [],
      patch: { start: 0, removed: '', inserted: '' },
    }) as TableOp

  it('a text draft takes what was saved as its base', () => {
    const now = { ...base, text: 'a\n3\n' }
    expect(rebaseDraft(now, base, '/r2', 'h2', 'utf-8')).toEqual({
      ...now,
      root: '/r2',
      baseHash: 'h2',
      base: 'a\n2\n',
      encoding: 'utf-8',
      cells: undefined,
    })
  })

  it('keeps the table edits made after the ones saved', () => {
    const saved = {
      ...base,
      cells: { delimiter: ',' as const, ops: [op(1)], redo: [] },
    }
    const now = { ...saved, cells: { ...saved.cells, ops: [op(1), op(2)] } }
    now.cells.ops[0] = saved.cells.ops[0]
    expect(rebaseDraft(now, saved, '/r', 'h2', 'utf-8').cells?.ops).toEqual([
      op(2),
    ])
  })

  it('goes on as text when the edits no longer begin with the ones saved', () => {
    const saved = {
      ...base,
      cells: { delimiter: ',' as const, ops: [op(1)], redo: [] },
    }
    const now = { ...saved, cells: { ...saved.cells, ops: [op(3)] } }
    expect(rebaseDraft(now, saved, '/r', 'h2', 'utf-8').cells).toBeUndefined()
  })
})

describe('FileViewer for a view-only device', () => {
  it('offers no way to show a sensitive file, and says why', async () => {
    mockContent.mockResolvedValueOnce({
      root: '/r',
      path: '.env',
      sensitive: true,
    })
    show({ path: '.env', canReveal: false })
    expect(
      await screen.findByText('A view-only device cannot show it'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/This file may contain secrets/),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('This file may contain secrets. Show its contents?'),
    ).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull()
    expect(mockContent).toHaveBeenCalledTimes(1)
  })

  it('a full device still asks before showing it', async () => {
    mockContent.mockResolvedValueOnce({
      root: '/r',
      path: '.env',
      sensitive: true,
    })
    show({ path: '.env' })
    expect(
      await screen.findByText(
        'This file may contain secrets. Show its contents?',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('A view-only device cannot show it')).toBeNull()
  })
})

describe('FileViewer download', () => {
  it('is offered with onDownload, for a file it cannot preview too', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'a.bin',
      size: 9,
      previewable: false,
      reason: 'binary',
    })
    const onDownload = vi.fn()
    show({ path: 'a.bin', onDownload })
    await screen.findByText(
      'Not previewable (binary, special file or larger than 4 MiB)',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(onDownload).toHaveBeenCalledWith({ revealed: false })
  })

  it('is not offered without onDownload', async () => {
    mockContent.mockResolvedValue({ root: '/r', path: 'a', size: 1, text: 'x' })
    show()
    await screen.findByTestId('code-block')
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
  })

  it('waits until a sensitive file is shown, then says it was', async () => {
    mockContent
      .mockResolvedValueOnce({ root: '/r', path: '.env', sensitive: true })
      .mockResolvedValueOnce({ root: '/r', path: '.env', size: 3, text: 'A=1' })
    const onDownload = vi.fn()
    show({ path: '.env', onDownload })
    await screen.findByText('This file may contain secrets. Show its contents?')
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    await screen.findByTestId('code-block')
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    expect(onDownload).toHaveBeenCalledWith({ revealed: true })
  })
})

describe('a draft found when the file is read', () => {
  // A draft of src/a.ts read from "old", edited to "mine" (as kept on the
  // device before the app closed)
  const keep = (over: Partial<FileDraft> = {}) => {
    const d: FileDraft = {
      root: '/r',
      path: 'src/a.ts',
      baseHash: 'h:old',
      base: 'old',
      crlf: false,
      text: 'mine',
      reveal: false,
      ...over,
    }
    renderHook(() => useFileDraft('%1', '/r', 'src/a.ts')).result.current[1](d)
  }
  const draftNow = () =>
    renderHook(() => useFileDraft('%1', '/r', 'src/a.ts')).result.current[0]

  it('of a file unchanged opens in the editor, unsaved', async () => {
    keep()
    mockContent.mockResolvedValue(editable('old'))
    show({ canEdit: true })
    await waitFor(() => expect(mockContent).toHaveBeenCalled())
    expect(textarea()).toHaveValue('mine')
    expect(saveButton()).toBeEnabled()
    expect(
      screen.queryByText('The file changed on the host since you opened it'),
    ).toBeNull()
  })

  it('of a file changed on the host says so; Reload asks first', async () => {
    keep()
    mockContent
      .mockResolvedValueOnce(editable('agent'))
      .mockResolvedValueOnce(editable('agent'))
    show({ canEdit: true })
    expect(
      await screen.findByText(
        'The file changed on the host since you opened it',
      ),
    ).toBeInTheDocument()
    expect(textarea()).toHaveValue('mine')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(await screen.findByTestId('code-block')).toHaveTextContent('agent')
    expect(draftNow()).toBeUndefined()
  })

  it('the file already holds is done with', async () => {
    keep()
    mockContent.mockResolvedValue(editable('mine'))
    show({ canEdit: true })
    expect(await screen.findByTestId('code-block')).toHaveTextContent('mine')
    expect(draftNow()).toBeUndefined()
    // CRLF on the host is the same text
    keep({ text: 'a\nb' })
    cleanup()
    mockContent.mockResolvedValue(editable('a\r\nb'))
    show({ canEdit: true })
    await waitFor(() => expect(draftNow()).toBeUndefined())
  })

  it('without changes stays, even with the file unchanged', async () => {
    keep({ text: 'old' })
    mockContent.mockResolvedValue(editable('old'))
    show({ canEdit: true })
    await waitFor(() => expect(mockContent).toHaveBeenCalled())
    expect(textarea()).toHaveValue('old')
    // Reload of a draft without changes needs no asking
    mockContent.mockResolvedValue(editable('old', { hash: 'h:new' }))
    cleanup()
    show({ canEdit: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }))
    expect(await screen.findByTestId('code-block')).toHaveTextContent('old')
  })

  it('of a file now sensitive goes, and the file is asked about', async () => {
    keep()
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      sensitive: true,
    })
    show({ canEdit: true })
    expect(await screen.findByText('Show this file?')).toBeInTheDocument()
    expect(draftNow()).toBeUndefined()
  })

  it('shown as sensitive stays when the file reads so', async () => {
    keep({ reveal: true })
    mockContent.mockResolvedValue(editable('old'))
    show({ canEdit: true })
    await waitFor(() => expect(mockContent).toHaveBeenCalled())
    expect(mockContent).toHaveBeenCalledWith({ paneId: '%1' }, 'src/a.ts', {
      root: '/r',
      reveal: true,
    })
    expect(draftNow()?.text).toBe('mine')
  })

  it('of another root, or of a file not text, is left as it is', async () => {
    keep({ root: '/old' })
    mockContent.mockResolvedValue(editable('mine'))
    show({ canEdit: true })
    await waitFor(() => expect(mockContent).toHaveBeenCalled())
    expect(draftNow()?.text).toBe('mine')
    cleanup()
    keep()
    mockContent.mockResolvedValue({ root: '/r', size: 9, previewable: false })
    show({ canEdit: true })
    await waitFor(() => expect(mockContent).toHaveBeenCalledTimes(2))
    expect(draftNow()?.text).toBe('mine')
  })

  it('of a file gone from the host can be copied or discarded', async () => {
    keep()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    mockContent.mockRejectedValue(new RequestError(404, '', 'not found'))
    show({ canEdit: true })
    expect(
      await screen.findByText('This file is no longer on the host'),
    ).toBeInTheDocument()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Copy my text' })),
    )
    expect(writeText).toHaveBeenCalledWith('mine')
    // Discard asks first: the text would be lost
    const banner = screen
      .getByText('This file is no longer on the host')
      .closest('[role]') as HTMLElement
    fireEvent.click(within(banner).getByRole('button', { name: 'Discard' }))
    expect(screen.getByText('Discard changes?')).toBeInTheDocument()
  })

  it('of a file that cannot be read now shows no banner', async () => {
    keep()
    mockContent.mockRejectedValue(new Error('offline'))
    show({ canEdit: true })
    await waitFor(() => expect(mockContent).toHaveBeenCalled())
    expect(screen.queryByText('This file is no longer on the host')).toBeNull()
    expect(textarea()).toHaveValue('mine')
  })

  it('a read answering after the draft went changes nothing', async () => {
    keep()
    let answer!: (v: unknown) => void
    mockContent.mockImplementation(() => new Promise((r) => (answer = r)))
    show({ canEdit: true })
    const setDraft = renderHook(() => useFileDraft('%1', '/r', 'src/a.ts'))
      .result.current[1]
    act(() => setDraft(undefined))
    await act(async () => answer(editable('agent')))
    expect(
      screen.queryByText('The file changed on the host since you opened it'),
    ).toBeNull()
  })
})

describe('FileViewer at a search result', () => {
  const rerenderAt = (
    view: ReturnType<typeof show>,
    over: Partial<Parameters<typeof FileViewer>[0]>,
  ) =>
    view.rerender(
      <ThemeProvider>
        <FileViewer {...view} {...over} />
      </ThemeProvider>,
    )

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('shows Markdown as its source for this tab only, the setting unchanged', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'a.md',
      size: 9,
      text: '# A\n\nfoo',
    })
    const view = show({ path: 'a.md', line: 3, jump: 1 })
    expect(await screen.findByTestId('code-block')).toHaveTextContent('foo')
    const row = screen
      .getByTestId('code-block')
      .querySelector('[data-line="3"]')
    expect(row).toHaveClass('bg-accent/15')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
    })
    const toggle = screen.getByRole('button', { name: 'Preview' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(localStorage.getItem('termote-settings')).toBeNull()
    // The user's toggle brings the preview back, the setting as it was
    fireEvent.click(toggle)
    expect(
      await screen.findByRole('heading', { name: 'A' }),
    ).toBeInTheDocument()
    expect(localStorage.getItem('termote-settings')).toBeNull()
    // Another pick: the source again, at its line
    rerenderAt(view, { path: 'a.md', line: 1, jump: 2 })
    expect(await screen.findByTestId('code-block')).toBeInTheDocument()
    expect(
      screen.getByTestId('code-block').querySelector('[data-line="1"]'),
    ).toHaveClass('bg-accent/15')
  })

  it('with Markdown shown as source already, the toggle turns the preview on', async () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ markdownPreview: false }),
    )
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'a.md',
      size: 3,
      text: '# A',
    })
    show({ path: 'a.md', line: 1, jump: 1 })
    await screen.findByTestId('code-block')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(
      await screen.findByRole('heading', { name: 'A' }),
    ).toBeInTheDocument()
    expect(
      JSON.parse(localStorage.getItem('termote-settings')!).markdownPreview,
    ).toBe(true)
  })

  it('shows a CSV table as its source; the toggle brings the table back', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'd.csv',
      size: 7,
      text: 'a,b\n1,2\n',
    })
    show({ path: 'd.csv', line: 2, jump: 1 })
    expect(await screen.findByTestId('code-block')).toHaveTextContent('1,2')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('grid')).toBeInTheDocument()
    expect(localStorage.getItem('termote-settings')).toBeNull()
  })

  it('shows an SVG as text; the Image toggle brings the image back', async () => {
    localStorage.setItem(
      'termote-settings',
      JSON.stringify({ svgPreview: true }),
    )
    mockImage.mockResolvedValue({
      url: 'blob:u1',
      size: 6,
      type: 'image/svg+xml',
    })
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'logo.svg',
      size: 6,
      text: '<svg/>',
    })
    show({ path: 'logo.svg', line: 1, jump: 1 })
    expect(await screen.findByTestId('code-block')).toHaveTextContent('<svg/>')
    const toggle = screen.getByRole('button', { name: 'Image' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(
      JSON.parse(localStorage.getItem('termote-settings')!).svgPreview,
    ).toBe(true)
  })

  it('an SVG shown as text by the setting: the Image toggle turns the image on', async () => {
    mockImage.mockResolvedValue({
      url: 'blob:u1',
      size: 6,
      type: 'image/svg+xml',
    })
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'logo.svg',
      size: 6,
      text: '<svg/>',
    })
    show({ path: 'logo.svg', line: 1, jump: 1 })
    await screen.findByTestId('code-block')
    fireEvent.click(screen.getByRole('button', { name: 'Image' }))
    expect(
      JSON.parse(localStorage.getItem('termote-settings')!).svgPreview,
    ).toBe(true)
  })

  it('a line picked while editing without changes is not told', async () => {
    mockContent.mockResolvedValue(editable('x\ny'))
    const view = await startEdit()
    rerenderAt(view, { canEdit: true, line: 2, jump: 5 })
    expect(view.notify).not.toHaveBeenCalledWith(
      'Unsaved changes: line 2 may have moved',
    )
  })

  it('a line picked over unsaved changes is told, the draft shown as it is', async () => {
    mockContent.mockResolvedValue(editable('x\ny'))
    const view = await startEdit()
    type('changed')
    rerenderAt(view, { canEdit: true, line: 2, jump: 5 })
    expect(view.notify).toHaveBeenCalledWith(
      'Unsaved changes: line 2 may have moved',
    )
    expect(textarea()).toHaveValue('changed')
  })

  describe('in the desktop editor', () => {
    beforeEach(() => {
      pointer.fine = true
    })
    afterEach(() => {
      pointer.fine = false
    })

    it('a result picked while editing moves the cursor to its match', async () => {
      mockContent.mockResolvedValue(editable('x\nabcdef'))
      const view = await startEdit()
      expect(await screen.findByTestId('code-editor')).toHaveTextContent(
        'at none',
      )
      rerenderAt(view, { canEdit: true, line: 2, col: 3, jump: 5 })
      expect(screen.getByTestId('code-editor')).toHaveTextContent('at 2:3')
    })

    it('a result picked before Edit leaves the editor where the text was', async () => {
      mockContent.mockResolvedValue(editable('x\nabcdef'))
      await startEdit({ line: 2, col: 3, jump: 1 })
      expect(await screen.findByTestId('code-editor')).toHaveTextContent(
        'at none',
      )
    })
  })
})

describe('FileViewer review comments', () => {
  it('comments on lines of the file, quoted', async () => {
    mockContent.mockResolvedValue(editable('a\nb\nc'))
    const onLineComment = vi.fn()
    show({ onLineComment, commentedLines: new Set([3]) })
    fireEvent.click(await screen.findByRole('button', { name: 'Line 2' }))
    expect(screen.getByRole('button', { name: 'Line 3' })).toHaveAttribute(
      'data-commented',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(onLineComment).toHaveBeenCalledWith({
      start: 2,
      end: 2,
      quote: 'b',
    })
  })

  it('never quotes a sensitive file shown', async () => {
    mockContent.mockResolvedValue(editable('A=1', { path: '.env' }))
    const onLineComment = vi.fn()
    show({ onLineComment, path: '.env', initialReveal: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Line 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(onLineComment).toHaveBeenCalledWith({
      start: 1,
      end: 1,
      sensitive: true,
    })
  })

  it('comments on the lines selected in the editor, marked unsaved once edited', async () => {
    mockContent.mockResolvedValue(editable('a\nb\nc'))
    const onLineComment = vi.fn()
    await startEdit({ onLineComment })
    const box = textarea() as HTMLTextAreaElement
    box.setSelectionRange(0, 3)
    const comment = screen.getByRole('button', { name: 'Comment on lines' })
    fireEvent.click(comment)
    expect(onLineComment).toHaveBeenLastCalledWith({
      start: 1,
      end: 2,
      quote: 'a\nb',
    })
    type('a\nB\nc')
    box.setSelectionRange(2, 3)
    fireEvent.click(comment)
    expect(onLineComment).toHaveBeenLastCalledWith({
      start: 2,
      end: 2,
      quote: 'B',
      unsaved: true,
    })
  })

  it('comments on nothing before the desktop editor is there', async () => {
    pointer.fine = true
    try {
      mockContent.mockResolvedValue(editable('a'))
      const onLineComment = vi.fn()
      await startEdit({ onLineComment })
      await screen.findByTestId('code-editor')
      fireEvent.click(screen.getByRole('button', { name: 'Comment on lines' }))
      expect(onLineComment).not.toHaveBeenCalled()
    } finally {
      pointer.fine = false
    }
  })

  it('offers no comment without a handler', async () => {
    mockContent.mockResolvedValue(editable('a'))
    await startEdit()
    expect(
      screen.queryByRole('button', { name: 'Comment on lines' }),
    ).toBeNull()
    expect(screen.queryByRole('button', { name: 'Line 1' })).toBeNull()
  })
})

describe('FileViewer: encodings', () => {
  const sjis = (text: string, over: Record<string, unknown> = {}) =>
    editable(text, { encoding: 'shift_jis', ...over })
  const encodingButton = (name: string) =>
    screen.getByRole('button', { name: `Encoding: ${name}` })
  const choose = (name: string) =>
    fireEvent.click(screen.getByRole('menuitemradio', { name }))
  const saveAsUtf8 = () =>
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as UTF-8' }))
  const confirm = () =>
    act(async () =>
      fireEvent.click(
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Save as UTF-8',
        }),
      ),
    )
  const draftNow = (path = 'src/a.ts') =>
    renderHook(() => useFileDraft('%1', '/r', path)).result.current[0]
  // A draft found at mount (kept on the device, or from another view)
  const putDraft = (d: FileDraft) => {
    const h = renderHook(() => useFileDraft('%1', '/r', d.path))
    act(() => h.result.current[1](d))
  }

  it.each([
    [editable('x', { encoding: 'utf-8' }), 'UTF-8'],
    [editable('x', { encoding: 'utf-8', bom: true }), 'UTF-8 with BOM'],
    [sjis('x'), 'Shift-JIS'],
    [editable('x', { encoding: 'utf-16le', bom: true }), 'UTF-16 LE with BOM'],
  ])('names the encoding in the header: %#', async (content, name) => {
    mockContent.mockResolvedValue(content)
    show()
    await screen.findByTestId('code-block')
    expect(encodingButton(name)).toHaveTextContent(name)
  })

  it('reads the file again as another encoding, the one in use ticked', async () => {
    mockContent.mockResolvedValue(sjis('x'))
    show()
    await screen.findByTestId('code-block')
    fireEvent.click(encodingButton('Shift-JIS'))
    expect(
      screen.getByRole('menuitemradio', { name: 'Shift-JIS' }),
    ).toHaveAttribute('aria-checked', 'true')
    mockContent.mockResolvedValue(editable('y', { encoding: 'euc-jp' }))
    await act(async () => choose('EUC-JP'))
    expect(mockContent).toHaveBeenLastCalledWith({ paneId: '%1' }, 'src/a.ts', {
      root: '/r',
      reveal: false,
      encoding: 'euc-jp',
    })
    expect(await screen.findByTestId('code-block')).toHaveTextContent('y')
    expect(encodingButton('EUC-JP')).toBeInTheDocument()
  })

  it('offers no reopening while the draft has changes; without, drops it', async () => {
    mockContent.mockResolvedValue(sjis('x'))
    await startEdit()
    fireEvent.click(encodingButton('Shift-JIS'))
    expect(screen.getByRole('menuitemradio', { name: 'EUC-JP' })).toBeEnabled()
    fireEvent.click(encodingButton('Shift-JIS'))
    type('changed')
    fireEvent.click(encodingButton('Shift-JIS'))
    const item = screen.getByRole('menuitemradio', { name: 'EUC-JP' })
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', 'Save or discard your changes first')
    fireEvent.click(encodingButton('Shift-JIS'))
    type('x')
    fireEvent.click(encodingButton('Shift-JIS'))
    await act(async () => choose('UTF-8'))
    expect(draftNow()).toBeUndefined()
    expect(mockContent).toHaveBeenLastCalledWith(
      { paneId: '%1' },
      'src/a.ts',
      expect.objectContaining({ encoding: 'utf-8' }),
    )
  })

  it('opens a file read as binary with an encoding', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      size: 4,
      previewable: false,
      reason: 'binary',
    })
    show()
    const open = await screen.findByRole('button', {
      name: 'Open with encoding',
    })
    expect(open).toHaveTextContent('Open with encoding…')
    fireEvent.click(open)
    mockContent.mockResolvedValue(editable('ab', { encoding: 'utf-16le' }))
    await act(async () => choose('UTF-16 LE'))
    expect(await screen.findByTestId('code-block')).toHaveTextContent('ab')
    expect(encodingButton('UTF-16 LE')).toBeInTheDocument()
  })

  it('has no encoding to name for a file too large to show', async () => {
    mockContent.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      size: 4,
      previewable: false,
      reason: 'too-large',
    })
    show()
    await screen.findByText(/Not previewable/)
    expect(screen.queryByRole('button', { name: /encoding/i })).toBeNull()
  })

  it('saves the text in the encoding it was read as', async () => {
    mockContent.mockResolvedValue(sjis('あ\n'))
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      size: 4,
      hash: 'h2',
      encoding: 'shift_jis',
    })
    await startEdit()
    type('い\n')
    await act(async () => fireEvent.click(saveButton()))
    expect(mockSave).toHaveBeenCalledWith(
      { paneId: '%1' },
      {
        root: '/r',
        path: 'src/a.ts',
        baseHash: 'h:あ\n',
        text: 'い\n',
        reveal: false,
        encoding: 'shift_jis',
        saveAs: undefined,
      },
    )
    expect(encodingButton('Shift-JIS')).toBeInTheDocument()
  })

  it('says which character the encoding cannot hold', async () => {
    mockContent.mockResolvedValue(sjis('あ\n'))
    mockSave.mockRejectedValue(
      new RequestError(422, 'unencodable', 'x', { line: 2, char: '😀' }),
    )
    await startEdit()
    type('あ\n😀\n')
    await act(async () => fireEvent.click(saveButton()))
    expect(
      screen.getByText(
        `Line 2 has "😀", which Shift-JIS can't hold. Change it or save as UTF-8`,
      ),
    ).toBeInTheDocument()
  })

  it('a draft kept from before encodings is saved without one', async () => {
    const legacy: FileDraft = {
      root: '/r',
      path: 'src/a.ts',
      baseHash: 'h:x',
      base: 'x',
      crlf: false,
      text: 'mine',
      reveal: false,
    }
    putDraft(legacy)
    mockContent.mockResolvedValue(editable('x', { encoding: 'utf-8' }))
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      size: 4,
      hash: 'h2',
      encoding: 'utf-8',
    })
    show({ canEdit: true })
    await waitFor(() => expect(mockContent).toHaveBeenCalled())
    expect(mockContent).toHaveBeenCalledWith({ paneId: '%1' }, 'src/a.ts', {
      root: '/r',
      reveal: false,
      encoding: undefined,
    })
    await act(async () => fireEvent.click(saveButton()))
    expect(mockSave.mock.calls[0][1].encoding).toBeUndefined()
  })

  it('a kept draft of a file with a BOM, from before encodings, saves its BOM once', async () => {
    putDraft({
      root: '/r',
      path: 'src/a.ts',
      baseHash: 'h:x',
      base: '\uFEFFx',
      crlf: false,
      text: '\uFEFFmine',
      reveal: false,
    })
    mockContent.mockResolvedValue(
      editable('x', { encoding: 'utf-8', bom: true }),
    )
    let done: (v: unknown) => void = () => {}
    mockSave.mockReturnValue(new Promise((r) => (done = r)))
    show({ canEdit: true })
    await waitFor(() => expect(mockContent).toHaveBeenCalled())
    fireEvent.click(saveButton())
    expect(mockSave.mock.calls[0][1]).toMatchObject({ text: '\uFEFFmine' })
    expect(mockSave.mock.calls[0][1].encoding).toBeUndefined()
    // Edited elsewhere while it saved: rebased without the BOM, now UTF-8
    const other = renderHook(() => useFileDraft('%1', '/r', 'src/a.ts'))
    const sent = other.result.current[0] as FileDraft
    act(() => other.result.current[1]({ ...sent, text: '\uFEFFmore' }))
    await act(async () =>
      done({
        root: '/r',
        path: 'src/a.ts',
        size: 7,
        hash: 'h2',
        encoding: 'utf-8',
        bom: true,
      }),
    )
    expect(other.result.current[0]).toMatchObject({
      base: 'mine',
      text: 'more',
      encoding: 'utf-8',
    })
    act(() => other.result.current[1](undefined))
    // The text shown, and the next draft, leave the BOM to the server
    expect(await screen.findByTestId('code-block')).toHaveTextContent(/^1mine$/)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(draftNow()).toMatchObject({ base: 'mine', encoding: 'utf-8' })
  })

  it('a file with bytes not valid in its encoding is not edited, nor saved as UTF-8', async () => {
    mockContent.mockResolvedValue(
      editable('a\uFFFD', {
        encoding: 'utf-8',
        bom: true,
        editable: false,
        notEditable: 'invalid-encoding',
      }),
    )
    show({ canEdit: true })
    await screen.findByTestId('code-block')
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.click(encodingButton('UTF-8 with BOM'))
    expect(
      screen.getByText(/some bytes are not valid in this encoding/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Save as UTF-8' })).toBeNull()
  })

  it('a kept draft of a file with a BOM, from before encodings, already in the file is done with', async () => {
    const legacy: FileDraft = {
      root: '/r',
      path: 'src/a.ts',
      baseHash: 'h:old',
      base: '﻿old',
      crlf: false,
      text: '﻿new',
      reveal: false,
    }
    putDraft(legacy)
    mockContent.mockResolvedValue(
      editable('new', { encoding: 'utf-8', bom: true }),
    )
    show({ canEdit: true })
    expect(await screen.findByTestId('code-block')).toHaveTextContent('new')
    expect(draftNow()).toBeUndefined()
  })

  it('a kept draft is read again in its own encoding, and named so', async () => {
    const kept: FileDraft = {
      root: '/r',
      path: 'src/a.ts',
      baseHash: 'h:x',
      base: 'x',
      crlf: false,
      encoding: 'euc-jp',
      text: 'mine',
      reveal: false,
    }
    putDraft(kept)
    mockContent.mockResolvedValue(editable('x', { encoding: 'euc-jp' }))
    show({ canEdit: true })
    await waitFor(() =>
      expect(mockContent).toHaveBeenCalledWith({ paneId: '%1' }, 'src/a.ts', {
        root: '/r',
        reveal: false,
        encoding: 'euc-jp',
      }),
    )
    expect(
      await screen.findByRole('button', { name: 'Encoding: EUC-JP' }),
    ).toBeInTheDocument()
  })

  it('Save as UTF-8 asks first, and sends nothing when cancelled', async () => {
    mockContent.mockResolvedValue(sjis('x', { bom: false }))
    show({ canEdit: true })
    await screen.findByTestId('code-block')
    fireEvent.click(encodingButton('Shift-JIS'))
    saveAsUtf8()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('instead of Shift-JIS.')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(mockSave).not.toHaveBeenCalled()
    expect(draftNow()).toBeUndefined()
  })

  it('names the BOM a save as UTF-8 drops', async () => {
    mockContent.mockResolvedValue(
      editable('x', { encoding: 'utf-16be', bom: true }),
    )
    show({ canEdit: true })
    await screen.findByTestId('code-block')
    fireEvent.click(encodingButton('UTF-16 BE with BOM'))
    saveAsUtf8()
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'without its byte order mark',
    )
  })

  it('Save as UTF-8 while viewing saves the text shown, then names UTF-8', async () => {
    mockContent.mockResolvedValue(sjis('a\r\nb\r\n'))
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      size: 6,
      hash: 'h2',
      encoding: 'utf-8',
    })
    const p = show({ canEdit: true, pinned: false, onPin: vi.fn() })
    await screen.findByTestId('code-block')
    fireEvent.click(encodingButton('Shift-JIS'))
    saveAsUtf8()
    await confirm()
    expect(mockSave).toHaveBeenCalledWith(
      { paneId: '%1' },
      {
        root: '/r',
        path: 'src/a.ts',
        baseHash: 'h:a\r\nb\r\n',
        text: 'a\nb\n',
        reveal: false,
        encoding: 'shift_jis',
        saveAs: 'utf-8',
      },
    )
    expect(p.onPin).toHaveBeenCalled()
    expect(draftNow()).toBeUndefined()
    expect(encodingButton('UTF-8')).toBeInTheDocument()
    // Plain UTF-8 now: nothing to convert
    fireEvent.click(encodingButton('UTF-8'))
    expect(screen.queryByRole('menuitem', { name: 'Save as UTF-8' })).toBeNull()
  })

  it('a refused save as UTF-8 leaves the text in a draft, saying why', async () => {
    mockContent.mockResolvedValue(sjis('x'))
    mockSave.mockRejectedValue(new RequestError(409, 'changed', 'changed'))
    show({ canEdit: true })
    await screen.findByTestId('code-block')
    fireEvent.click(encodingButton('Shift-JIS'))
    saveAsUtf8()
    await confirm()
    expect(draftNow()).toMatchObject({ text: 'x', encoding: 'shift_jis' })
    expect(
      screen.getByText('The file changed on the host since you opened it'),
    ).toBeInTheDocument()
  })

  it('Save as UTF-8 while editing saves the draft, after a reopen in another encoding', async () => {
    mockContent.mockResolvedValue(editable('x', { encoding: 'utf-8' }))
    show({ canEdit: true })
    await screen.findByTestId('code-block')
    fireEvent.click(encodingButton('UTF-8'))
    mockContent.mockResolvedValue(sjis('x'))
    await act(async () => choose('Shift-JIS'))
    await screen.findByRole('button', { name: 'Encoding: Shift-JIS' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    type('y')
    let done: (v: unknown) => void = () => {}
    mockSave.mockReturnValue(new Promise((r) => (done = r)))
    mockContent.mockResolvedValue(editable('y', { encoding: 'utf-8' }))
    fireEvent.click(encodingButton('Shift-JIS'))
    saveAsUtf8()
    await confirm()
    expect(mockSave).toHaveBeenLastCalledWith(
      { paneId: '%1' },
      expect.objectContaining({ text: 'y', saveAs: 'utf-8' }),
    )
    // Edited elsewhere while it saved: rebased on the UTF-8 file
    const other = renderHook(() => useFileDraft('%1', '/r', 'src/a.ts'))
    const sent = other.result.current[0] as FileDraft
    act(() => other.result.current[1]({ ...sent, text: 'z' }))
    await act(async () =>
      done({
        root: '/r',
        path: 'src/a.ts',
        size: 1,
        hash: 'h2',
        encoding: 'utf-8',
      }),
    )
    expect(other.result.current[0]).toMatchObject({
      base: 'y',
      baseHash: 'h2',
      encoding: 'utf-8',
    })
    // The choice of Shift-JIS is gone: read again as the server finds it
    expect(mockContent).toHaveBeenLastCalledWith({ paneId: '%1' }, 'src/a.ts', {
      root: '/r',
      reveal: false,
      encoding: undefined,
    })
  })

  it('a file that would lose bytes is not edited, but can be saved as UTF-8', async () => {
    mockContent.mockResolvedValue(
      sjis('髙', { editable: false, notEditable: 'lossy-encoding' }),
    )
    mockSave.mockResolvedValue({
      root: '/r',
      path: 'src/a.ts',
      size: 3,
      hash: 'h2',
      encoding: 'utf-8',
    })
    show({ canEdit: true })
    await screen.findByTestId('code-block')
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.click(encodingButton('Shift-JIS'))
    expect(
      screen.getByText(/saving would change bytes you did not edit/),
    ).toBeInTheDocument()
    saveAsUtf8()
    await confirm()
    expect(mockSave).toHaveBeenCalledWith(
      { paneId: '%1' },
      expect.objectContaining({ encoding: 'shift_jis', saveAs: 'utf-8' }),
    )
    // Saved: editable now
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
  })

  it.each([
    ['a view-only client', sjis('x'), { canEdit: false }],
    [
      'a file refused for another reason',
      sjis('x', { editable: false, notEditable: 'symlink' }),
      {},
    ],
  ])('offers no save as UTF-8 to %s', async (_, content, over) => {
    mockContent.mockResolvedValue(content)
    show({ canEdit: true, ...over })
    await screen.findByTestId('code-block')
    fireEvent.click(encodingButton('Shift-JIS'))
    expect(screen.queryByRole('menuitem', { name: 'Save as UTF-8' })).toBeNull()
  })

  it('Reload after a conflict reads the file as the server finds it', async () => {
    mockContent.mockResolvedValue(editable('x', { encoding: 'utf-8' }))
    show({ canEdit: true })
    await screen.findByTestId('code-block')
    fireEvent.click(encodingButton('UTF-8'))
    mockContent.mockResolvedValue(sjis('x'))
    await act(async () => choose('Shift-JIS'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    type('y')
    mockSave.mockRejectedValue(new RequestError(409, 'changed', 'changed'))
    await act(async () => fireEvent.click(saveButton()))
    mockContent.mockResolvedValue(editable('agent', { encoding: 'utf-8' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Discard' })),
    )
    expect(mockContent).toHaveBeenLastCalledWith({ paneId: '%1' }, 'src/a.ts', {
      root: '/r',
      reveal: false,
      encoding: undefined,
    })
  })

  it('tells a large Markdown file by its bytes, not its characters', async () => {
    // Few characters, many bytes on disk (UTF-16)
    mockContent.mockResolvedValue(
      editable('# T\n', {
        path: 'r.md',
        encoding: 'utf-16le',
        size: PREVIEW_MAX_BYTES + 2,
      }),
    )
    show({ path: 'r.md' })
    expect(
      await screen.findByText('Too large to preview: shown as source'),
    ).toBeInTheDocument()
  })
})

describe('FileViewer: encodings of a table', () => {
  it('Reload and reapply reads the file in the encoding the edits were made on', async () => {
    mockContent.mockResolvedValue(
      editable('a\n1\n', { path: 'd.csv', encoding: 'shift_jis' }),
    )
    mockSave.mockRejectedValueOnce(new RequestError(409, 'changed', 'changed'))
    show({ canEdit: true, path: 'd.csv' })
    await screen.findByRole('grid')
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('gridcell', { name: '1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), {
      target: { value: '2' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await act(async () => fireEvent.click(saveButton()))
    mockContent.mockResolvedValueOnce(
      editable('a\n1\nb\n', { path: 'd.csv', encoding: 'shift_jis' }),
    )
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Reload and reapply' }),
      ),
    )
    expect(mockContent).toHaveBeenLastCalledWith({ paneId: '%1' }, 'd.csv', {
      root: '/r',
      reveal: false,
      encoding: 'shift_jis',
    })
    expect(
      renderHook(() => useFileDraft('%1', '/r', 'd.csv')).result.current[0],
    ).toMatchObject({ encoding: 'shift_jis' })
  })
})
