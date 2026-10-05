import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ChangeEntry,
  type FileDiff,
  RequestError,
} from '../hooks/use-mux-api'
import { DiffViewer } from './diff-viewer'

const mockDiff = vi.fn()
const mockContent = vi.fn()
const mockImage = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFileDiff: (...a: unknown[]) => mockDiff(...a),
  fetchFileContent: (...a: unknown[]) => mockContent(...a),
  fetchFileImage: (...a: unknown[]) => mockImage(...a),
}))
vi.mock('../utils/highlight', async (orig) => ({
  ...(await orig<typeof import('../utils/highlight')>()),
  highlightLang: async () => null,
}))
vi.mock('../hooks/use-media-query', () => ({ useIsMobile: () => false }))

const ENTRY: ChangeEntry = {
  path: 'src/a.ts',
  staged: '',
  unstaged: 'M',
  sensitive: false,
}
const diff = (over: Partial<FileDiff> = {}): FileDiff => ({
  root: '/r',
  path: 'src/a.ts',
  truncated: false,
  hunks: [
    {
      header: '@@ -1,2 +1,2 @@',
      lines: [
        { kind: 'ctx', old: 1, new: 1, text: 'same' },
        { kind: 'del', old: 2, text: 'old' },
        { kind: 'add', new: 2, text: 'new', noNewline: true },
        { kind: 'add', new: 3, text: '' },
      ],
    },
  ],
  ...over,
})

type Props = Parameters<typeof DiffViewer>[0]
function show(over: Partial<Props> = {}) {
  const props: Props = {
    paneId: '%1',
    root: '/r',
    entry: ENTRY,
    waiting: false,
    path: 'src/a.ts',
    staged: false,
    isMobile: false,
    reload: 0,
    onClose: vi.fn(),
    onRootChanged: vi.fn(),
    onFollow: vi.fn(),
    notify: vi.fn(),
    ...over,
  }
  const view = render(<DiffViewer {...props} />)
  return {
    ...props,
    ...view,
    again: (o: Partial<Props>) =>
      view.rerender(<DiffViewer {...props} {...o} />),
  }
}

const rows = () => [
  ...screen.getByTestId('diff').querySelectorAll('[data-kind]'),
]

// The lazy Markdown renderer, loaded once up front: its first load can
// outlast a find under coverage
beforeAll(() => import('./markdown-preview'))

beforeEach(() => {
  mockContent.mockReset()
  mockDiff.mockReset()
  mockDiff.mockResolvedValue(diff())
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

describe('DiffViewer', () => {
  it('shows the hunks with both line numbers, signs and line colours', async () => {
    show()
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(await screen.findByText('@@ -1,2 +1,2 @@')).toBeInTheDocument()
    expect(mockDiff).toHaveBeenCalledWith(
      '%1',
      { path: 'src/a.ts', orig: undefined },
      { staged: false, root: '/r', reveal: false },
    )
    const [ctx, del, add] = rows()
    expect(ctx).toHaveTextContent('11 same')
    expect(del).toHaveClass('bg-diff-del')
    expect(del).toHaveTextContent('2-old')
    expect(add).toHaveClass('bg-diff-add')
    expect(add).toHaveTextContent('2+new (no newline at end of file)')
    expect(screen.getByText('Not staged')).toBeInTheDocument()
  })

  it('keeps one number column on a narrow screen and wraps there', async () => {
    show({
      isMobile: true,
      staged: true,
      entry: { ...ENTRY, staged: 'R', orig: 'src/old.ts' },
    })
    await screen.findByTestId('diff')
    const [ctx, del, add] = rows()
    expect(ctx).toHaveTextContent('1 same')
    expect(del).toHaveTextContent('2-old')
    expect(add).toHaveTextContent('2+new')
    expect(screen.getByText(/src\/old\.ts → src\/a\.ts/)).toBeInTheDocument()
    expect(screen.getByText('Staged')).toBeInTheDocument()
    const wrap = screen.getByRole('button', { name: 'Wrap lines' })
    expect(wrap).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(wrap)
    expect(wrap).toHaveAttribute('aria-pressed', 'false')
  })

  it.each([
    [{ binary: true, hunks: [] }, 'Binary file changed'],
    [
      { reason: 'too-large' as const, hunks: [] },
      'Not previewable (special file or larger than 1 MiB)',
    ],
    [{ hunks: [] }, 'No content changes'],
    [{ hunks: null }, 'No content changes'],
  ])('%o says %s', async (over, text) => {
    mockDiff.mockResolvedValue(diff(over))
    show()
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('warns of a cut diff and of a conflict', async () => {
    mockDiff.mockResolvedValue(diff({ truncated: true, conflict: true }))
    show()
    expect(
      await screen.findByText('Diff truncated at 1 MiB'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Unresolved conflict: the file as it is now'),
    ).toBeInTheDocument()
  })

  it.each([
    [404, 'No longer changed'],
    [403, "This file can't be shown"],
    [501, 'Not supported by this backend'],
    [503, 'Could not load the diff'],
  ])('a %i says why', async (status, text) => {
    mockDiff.mockRejectedValue(new RequestError(status, '', 'x'))
    show()
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('an entry gone from the status is no longer changed, without asking', () => {
    show({ entry: undefined })
    expect(screen.getByText('No longer changed')).toBeInTheDocument()
    expect(mockDiff).not.toHaveBeenCalled()
  })

  it('waits while the status is read again', () => {
    show({ waiting: true, entry: undefined })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('reads the diff again when its entry changes or on refresh, not otherwise', async () => {
    const v = show()
    await screen.findByTestId('diff')
    v.again({ entry: { ...ENTRY } })
    expect(mockDiff).toHaveBeenCalledTimes(1)
    v.again({ entry: { ...ENTRY, staged: 'M' } })
    await screen.findByTestId('diff')
    expect(mockDiff).toHaveBeenCalledTimes(2)
    v.again({ entry: { ...ENTRY, staged: 'M' }, reload: 1 })
    await screen.findByTestId('diff')
    expect(mockDiff).toHaveBeenCalledTimes(3)
  })

  it('asks before a sensitive diff; yes reads it with reveal, no goes back', async () => {
    mockDiff.mockResolvedValueOnce({ ...diff(), sensitive: true, hunks: null })
    const v = show()
    expect(
      await screen.findByText(
        'This file may contain secrets. Show its contents?',
      ),
    ).toBeInTheDocument()
    // The dialog's text renders before showModal opens it, and its buttons are
    // only accessible once it is open
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    await screen.findByTestId('diff')
    expect(mockDiff).toHaveBeenLastCalledWith(
      '%1',
      expect.anything(),
      expect.objectContaining({ reveal: true }),
    )
    v.unmount()
    mockDiff.mockResolvedValueOnce({ ...diff(), sensitive: true, hunks: null })
    const w = show()
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(w.onClose).toHaveBeenCalled()
  })

  it('hands a moved root up and drops answers no longer wanted', async () => {
    let fail!: (e: unknown) => void
    let finish!: (v: unknown) => void
    mockDiff
      .mockRejectedValueOnce(
        new RequestError(409, '', 'root changed', undefined, undefined, '/n'),
      )
      .mockReturnValueOnce(new Promise((_, r) => (fail = r)))
      .mockReturnValueOnce(new Promise((r) => (finish = r)))
      .mockResolvedValue(diff())
    const v = show()
    await act(async () => {})
    expect(v.onRootChanged).toHaveBeenCalledWith('/n')
    v.again({ root: '/n' })
    v.again({ root: '/n2' })
    v.again({ root: '/n3' })
    await act(async () => {
      fail(new Error('x'))
      finish(diff({ binary: true }))
    })
    expect(await screen.findByTestId('diff')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to changes' }))
    expect(v.onClose).toHaveBeenCalled()
  })
})

describe('DiffViewer: Markdown preview', () => {
  const MD: ChangeEntry = { ...ENTRY, path: 'docs/a.md' }
  const content = (text: string, size = text.length) => ({
    root: '/r',
    path: 'docs/a.md',
    size,
    text,
  })

  it('shows the diff first, then the current version rendered', async () => {
    mockContent.mockResolvedValue(content('# Now\n\n[b](b.md)'))
    const v = show({ entry: MD, path: 'docs/a.md' })
    expect(await screen.findByTestId('diff')).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Preview' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)
    expect(await screen.findByRole('heading', { name: 'Now' })).toBeVisible()
    expect(screen.queryByTestId('diff')).toBeNull()
    expect(mockContent).toHaveBeenCalledWith('%1', 'docs/a.md', {
      root: '/r',
      reveal: false,
    })
    fireEvent.click(screen.getByRole('button', { name: 'b' }))
    expect(v.onFollow).toHaveBeenCalledWith(
      { kind: 'path', path: 'docs/b.md', anchor: undefined },
      0,
    )

    // Read again with the diff
    v.again({ entry: MD, path: 'docs/a.md', reload: 1 })
    await act(async () => {})
    expect(mockContent).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByTestId('diff')).toBeInTheDocument()
  })

  it('keeps the preview and its scroll while it is read again', async () => {
    let finish!: (v: unknown) => void
    mockContent
      .mockResolvedValueOnce(content('# Before'))
      .mockReturnValueOnce(new Promise((r) => (finish = r)))
    const v = show({ entry: MD, path: 'docs/a.md' })
    await screen.findByTestId('diff')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByRole('heading', { name: 'Before' })
    const box = screen.getByTestId('markdown-preview')
    box.scrollTop = 80

    // Refresh: the previous version stays until the new one is read
    v.again({ entry: MD, path: 'docs/a.md', reload: 1 })
    await act(async () => {})
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Before' })).toBeVisible()

    await act(async () => finish(content('# After')))
    expect(screen.getByRole('heading', { name: 'After' })).toBeVisible()
    // The same scroll box, where it was
    expect(screen.getByTestId('markdown-preview')).toBe(box)
    expect(box.scrollTop).toBe(80)
  })

  it('has no preview of a deleted file or of other files', async () => {
    show({ entry: { ...MD, unstaged: 'D' }, path: 'docs/a.md' })
    await screen.findByTestId('diff')
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
  })

  it('has no preview for a file that is not Markdown', async () => {
    show()
    await screen.findByTestId('diff')
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
  })

  it('previews the staged side unless it deletes the file', async () => {
    mockContent.mockResolvedValue(content('ok'))
    show({
      entry: { ...MD, staged: 'M', unstaged: '' },
      path: 'docs/a.md',
      staged: true,
    })
    await screen.findByTestId('diff')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText('ok')).toBeInTheDocument()
  })

  it.each([
    [
      { root: '/r', path: 'docs/a.md', sensitive: true },
      'This file may contain secrets',
    ],
    [
      {
        root: '/r',
        path: 'docs/a.md',
        size: 9,
        previewable: false,
        reason: 'binary',
      },
      'Not previewable (binary, special file or larger than 1 MiB)',
    ],
    [content('x', 300 * 1024), 'Too large to preview'],
  ])('says why it cannot preview %#', async (c, text) => {
    mockContent.mockResolvedValue(c)
    show({ entry: MD, path: 'docs/a.md' })
    await screen.findByTestId('diff')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it.each([
    [new RequestError(404, '', 'gone'), 'File not found'],
    [new Error('offline'), 'Could not load the file'],
  ])('says when the file cannot be read: %s', async (err, text) => {
    mockContent.mockRejectedValue(err)
    show({ entry: MD, path: 'docs/a.md' })
    await screen.findByTestId('diff')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(await screen.findByText(text)).toBeInTheDocument()
  })

  it('drops a read no longer wanted', async () => {
    let finish!: (v: unknown) => void
    let fail!: (e: unknown) => void
    mockContent
      .mockReturnValueOnce(new Promise((r) => (finish = r)))
      .mockReturnValueOnce(new Promise((_, r) => (fail = r)))
      .mockResolvedValue(content('latest'))
    const v = show({ entry: MD, path: 'docs/a.md' })
    await screen.findByTestId('diff')
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    v.again({ entry: MD, path: 'docs/a.md', reload: 1 })
    v.again({ entry: MD, path: 'docs/a.md', reload: 2 })
    await act(async () => {
      finish(content('old'))
      fail(new Error('x'))
    })
    expect(await screen.findByText('latest')).toBeInTheDocument()
    expect(screen.queryByText('old')).toBeNull()
  })
})

describe('DiffViewer: images', () => {
  const PNG: ChangeEntry = { ...ENTRY, path: 'img/a.png' }
  const SVG: ChangeEntry = { ...ENTRY, path: 'logo.svg' }
  let made = 0
  beforeEach(() => {
    made = 0
    localStorage.clear()
    mockImage.mockReset()
    mockImage.mockResolvedValue(new Blob(['x']))
    URL.createObjectURL = vi.fn(() => `blob:u${++made}`)
    URL.revokeObjectURL = vi.fn()
  })

  it('shows before and after instead of a diff', async () => {
    show({ entry: PNG, path: 'img/a.png' })
    expect(await screen.findAllByRole('img')).toHaveLength(2)
    expect(mockDiff).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Wrap lines' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Image' })).toBeNull()
  })

  it('reads again on a refresh, with the version of the entry', async () => {
    const v = show({ entry: PNG, path: 'img/a.png' })
    await screen.findAllByRole('img')
    v.again({ entry: { ...PNG }, path: 'img/a.png' })
    expect(mockImage).toHaveBeenCalledTimes(2)
    v.again({ entry: PNG, path: 'img/a.png', reload: 1 })
    await waitFor(() => expect(mockImage).toHaveBeenCalledTimes(4))
  })

  it('asks before reading a sensitive image', async () => {
    show({ entry: { ...PNG, sensitive: true }, path: 'img/a.png' })
    expect(
      screen.getByText('This file may contain secrets'),
    ).toBeInTheDocument()
    expect(mockImage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(await screen.findAllByRole('img')).toHaveLength(2)
    expect(mockImage.mock.calls[0][2]).toMatchObject({ reveal: true })
  })

  it('asks when the server finds the name sensitive', async () => {
    mockImage.mockRejectedValueOnce(
      new RequestError(403, 'sensitive', 'sensitive'),
    )
    show({ entry: PNG, path: 'img/a.png' })
    fireEvent.click(await screen.findByRole('button', { name: 'Show' }))
    expect(await screen.findAllByRole('img')).toHaveLength(2)
    expect(mockImage.mock.lastCall?.[2]).toMatchObject({ reveal: true })
  })

  it('waits for the status, and says when the image is no longer changed', () => {
    const v = show({ entry: PNG, path: 'img/a.png', waiting: true })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    v.again({ entry: undefined, path: 'img/a.png', waiting: false })
    expect(screen.getByText('No longer changed')).toBeInTheDocument()
    expect(mockImage).not.toHaveBeenCalled()
  })

  it('shows an SVG as a diff until Image is picked', async () => {
    show({ entry: SVG, path: 'logo.svg' })
    await screen.findByTestId('diff')
    const toggle = screen.getByRole('button', { name: 'Image' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(await screen.findAllByRole('img')).toHaveLength(2)
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle)
    expect(await screen.findByTestId('diff')).toBeInTheDocument()
    expect(mockDiff).toHaveBeenCalledTimes(2)
  })
})
