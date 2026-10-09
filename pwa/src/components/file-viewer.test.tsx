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
import type { TableOp } from '../utils/csv-edits'
import { FileViewer, rebaseDraft } from './file-viewer'

const mockContent = vi.fn()
const mockImage = vi.fn()
const mockSave = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFileContent: (...a: unknown[]) => mockContent(...a),
  fetchFileImage: (...a: unknown[]) => mockImage(...a),
  saveFileContent: (...a: unknown[]) => mockSave(...a),
}))
vi.mock('../utils/highlight', async (orig) => ({
  ...(await orig<typeof import('../utils/highlight')>()),
  highlight: async () => null,
  highlightLang: async () => null,
}))
vi.mock('../hooks/use-media-query', () => ({
  useIsMobile: () => false,
  useMediaQuery: () => false,
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
    expect(mockSave).toHaveBeenCalledWith('%1', {
      root: '/r',
      path: 'src/a.ts',
      baseHash: 'h:a\nb\n',
      text: 'a\nc\n',
      reveal: false,
    })
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
      '%1',
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
      '%1',
      expect.objectContaining({ text: 'a\nc\n' }),
    )
    expect(screen.getByTestId('code-block')).toHaveTextContent(/^1a\s*2c\s*$/)
  })

  it('a Markdown file is edited as its source, even when previewed', async () => {
    mockContent.mockResolvedValue(editable('# T\n', { path: 'r.md' }))
    show({ canEdit: true, path: 'r.md' })
    await screen.findByRole('heading', { name: 'T' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('textbox', { name: 'Text of r.md' })).toHaveValue(
      '# T\n',
    )
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
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
      new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
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

  it('a draft from before the root moved shows the move and is not saved', async () => {
    mockContent.mockResolvedValue(editable('x'))
    const p = await startEdit()
    type('draft')
    p.unmount()
    mockContent.mockResolvedValue(editable('x', { root: '/n' }))
    show({ canEdit: true, root: '/n' })
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
    expect(mockContent).toHaveBeenCalledWith('%1', '.env', {
      root: '/r',
      reveal: true,
    })
    fireEvent.change(box, { target: { value: 'A=2' } })
    await act(async () => fireEvent.click(saveButton()))
    expect(mockSave).toHaveBeenCalledWith(
      '%1',
      expect.objectContaining({ reveal: true }),
    )
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
    expect(mockSave).toHaveBeenCalledWith('%1', {
      root: '/r',
      path: 'd.csv',
      baseHash: `h:${text}`,
      text: '﻿name,price\npear,2.5\nplum,3\n',
      reveal: false,
    })
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
      '%1',
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
    const draft = renderHook(() => useFileDraft('%1', 'd.csv'))
    expect(draft.result.current[0]).toMatchObject({
      path: 'd.csv',
      cells: { delimiter: ';', ops: [], redo: [] },
    })
    const a = renderHook(() => useFileDraft('%1', 'src/a.ts'))
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
    const mine = renderHook(() => useFileDraft('%1', 'd.csv'))
    const other = renderHook(() => useFileDraft('%1', 'b.ts'))
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
    const other = renderHook(() => useFileDraft('%1', 'd.csv'))
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
    const other = renderHook(() => useFileDraft('%1', 'd.csv'))
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
    expect(mockContent).toHaveBeenLastCalledWith('%1', 'd.csv', {
      root: '/r',
      reveal: false,
    })
    expect(screen.queryByText(/changed on the host/)).toBeNull()
    const draft = renderHook(() => useFileDraft('%1', 'd.csv')).result
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
      '%1',
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
    const other = renderHook(() => useFileDraft('%1', 'd.csv'))
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
    const draft = renderHook(() => useFileDraft('%1', 'd.csv')).result
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
    expect(rebaseDraft(now, base, '/r2', 'h2')).toEqual({
      ...now,
      root: '/r2',
      baseHash: 'h2',
      base: 'a\n2\n',
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
    expect(rebaseDraft(now, saved, '/r', 'h2').cells?.ops).toEqual([op(2)])
  })

  it('goes on as text when the edits no longer begin with the ones saved', () => {
    const saved = {
      ...base,
      cells: { delimiter: ',' as const, ops: [op(1)], redo: [] },
    }
    const now = { ...saved, cells: { ...saved.cells, ops: [op(3)] } }
    expect(rebaseDraft(now, saved, '/r', 'h2').cells).toBeUndefined()
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
