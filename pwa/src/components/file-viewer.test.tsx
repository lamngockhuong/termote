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
import { resetFilesStores } from '../hooks/use-files'
import { RequestError } from '../hooks/use-mux-api'
import { FileViewer } from './file-viewer'

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

  it('a CSV is edited as its source', async () => {
    mockContent.mockResolvedValue({
      ...csv('a,b\n'),
      hash: 'h',
      editable: true,
    })
    show({ path: 'data/a.csv', canEdit: true })
    await screen.findByRole('grid')
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

  it('editing another file asks before dropping unsaved changes to the first', async () => {
    mockContent.mockResolvedValue(editable('x'))
    const p = await startEdit()
    type('draft of a')
    p.unmount()
    mockContent.mockResolvedValue(editable('y', { path: 'b.ts' }))
    show({ canEdit: true, path: 'b.ts' })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(
      await screen.findByText('Your unsaved changes to src/a.ts will be lost.'),
    ).toBeInTheDocument()
    // Keep them
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    expect(screen.getByRole('textbox', { name: 'Text of b.ts' })).toHaveValue(
      'y',
    )
  })

  it('startEditing asks too when another file has unsaved changes', async () => {
    mockContent.mockResolvedValue(editable('x'))
    const p = await startEdit()
    type('draft of a')
    p.unmount()
    mockContent.mockResolvedValue(editable('y', { path: 'b.ts' }))
    show({ canEdit: true, path: 'b.ts', startEditing: true })
    expect(
      await screen.findByText('Your unsaved changes to src/a.ts will be lost.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('an unchanged draft of another file is replaced without asking', async () => {
    mockContent.mockResolvedValue(editable('x'))
    const p = await startEdit()
    p.unmount()
    mockContent.mockResolvedValue(editable('y', { path: 'b.ts' }))
    show({ canEdit: true, path: 'b.ts' })
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('textbox', { name: 'Text of b.ts' })).toHaveValue(
      'y',
    )
  })
})
