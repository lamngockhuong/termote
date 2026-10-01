import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ChangeEntry,
  type FileDiff,
  RequestError,
} from '../hooks/use-mux-api'
import { DiffViewer } from './diff-viewer'

const mockDiff = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFileDiff: (...a: unknown[]) => mockDiff(...a),
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

beforeEach(() => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
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
