import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetGitChangesStores } from '../hooks/use-git-changes'
import type {
  ChangeEntry,
  GitChanges,
  TouchedFile,
  TouchedFiles,
} from '../hooks/use-mux-api'
import {
  TouchedFilesList,
  TouchedFilesSection,
  touchedRow,
} from './touched-files-list'

const mockTouched = vi.fn()
const mockChanges = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchTouchedFiles: (...a: unknown[]) => mockTouched(...a),
  fetchGitChanges: (...a: unknown[]) => mockChanges(...a),
}))

const f = (path: string, over: Partial<TouchedFile> = {}): TouchedFile => ({
  path,
  sensitive: false,
  ...over,
})
const e = (
  path: string,
  staged: string,
  unstaged: string,
  over: Partial<ChangeEntry> = {},
): ChangeEntry => ({ path, staged, unstaged, sensitive: false, ...over })
const data = (files: TouchedFile[], over: Partial<TouchedFiles> = {}) => ({
  files,
  skipped: 0,
  truncated: false,
  ...over,
})

beforeEach(() => {
  resetGitChangesStores()
  mockTouched.mockReset()
  mockChanges.mockReset()
})

describe('touchedRow', () => {
  const entries = [
    e('both.ts', 'M', 'M'),
    e('staged.ts', 'A', ''),
    e('new.ts', '', '?'),
    e('merge.ts', 'M', 'M', { conflict: true }),
    e('to.ts', 'R', '', { orig: 'from.ts' }),
  ]
  it('opens the side git lists, the worktree side first', () => {
    expect(touchedRow(f('both.ts'), entries)).toMatchObject({
      code: 'M',
      clean: false,
      target: { kind: 'diff', side: { path: 'both.ts', staged: false } },
    })
    expect(touchedRow(f('staged.ts'), entries).target).toEqual({
      kind: 'diff',
      side: { path: 'staged.ts', orig: undefined, staged: true },
    })
    expect(touchedRow(f('new.ts'), entries).code).toBe('?')
    expect(touchedRow(f('merge.ts'), entries)).toMatchObject({
      code: 'U',
      target: { side: { staged: false } },
    })
    expect(touchedRow(f('to.ts'), entries).target).toMatchObject({
      side: { orig: 'from.ts', staged: true },
    })
  })

  it('opens a file git lists no change of in Files, a deleted one nowhere', () => {
    expect(touchedRow(f('done.ts', { ops: ['edit'] }), entries)).toEqual({
      file: f('done.ts', { ops: ['edit'] }),
      code: '',
      clean: true,
      target: { kind: 'file', path: 'done.ts' },
    })
    expect(touchedRow(f('x.ts', { ops: ['delete'] }), entries).target).toBe(
      undefined,
    )
    // Written again after: there
    expect(
      touchedRow(f('x.ts', { ops: ['write', 'delete'] }), entries).target,
    ).toEqual({ kind: 'file', path: 'x.ts' })
    // git status not read: no status to tell
    expect(touchedRow(f('done.ts'), undefined).clean).toBe(false)
  })
})

describe('TouchedFilesList', () => {
  it('waits, then tells why it could not read', () => {
    const { rerender } = render(
      <TouchedFilesList state={{}} entries={[]} onOpen={vi.fn()} />,
    )
    expect(screen.getByText('Loading…')).toBeTruthy()
    for (const [error, text] of [
      ['view-only', 'A view-only device sees them only in a git repository.'],
      ['none', 'This pane runs no Claude Code or Codex session.'],
      ['failed', "The files this session changed can't be read."],
    ] as const) {
      rerender(
        <TouchedFilesList state={{ error }} entries={[]} onOpen={vi.fn()} />,
      )
      expect(screen.getByRole('alert')).toHaveTextContent(text)
    }
  })

  it('always says shell commands are not seen; counts what is left out', () => {
    const { rerender } = render(
      <TouchedFilesList
        state={{ data: data([]) }}
        entries={[]}
        onOpen={vi.fn()}
      />,
    )
    expect(
      screen.getByText(
        'Files changed by shell commands (sed, mv, scripts) are not listed.',
      ),
    ).toBeTruthy()
    expect(screen.getByRole('status')).toHaveTextContent(
      'This session has not changed any file yet.',
    )
    rerender(
      <TouchedFilesList
        state={{ data: data([f('a')], { skipped: 2, truncated: true }) }}
        entries={[]}
        onOpen={vi.fn()}
      />,
    )
    expect(
      screen.getByText('2 files outside this folder are not shown.'),
    ).toBeTruthy()
    expect(
      screen.getByText('Only the 2000 latest files are shown.'),
    ).toBeTruthy()
  })

  it('shows each file with its status and what the session did', () => {
    const onOpen = vi.fn()
    render(
      <TouchedFilesList
        state={{
          data: data([
            f('src/a.ts', { ops: ['edit'], count: 3, sub: true }),
            f('src/b.ts', { ops: ['edit'], count: 1, running: true }),
            f('.env', { sensitive: true }),
            f('old.ts', { ops: ['delete'] }),
          ]),
        }}
        entries={[e('src/a.ts', '', 'M')]}
        onOpen={onOpen}
      />,
    )
    const a = screen.getByRole('button', { name: /a\.ts/ })
    expect(a).toHaveTextContent('MModified: a.tssrc/subagent×3')
    expect(screen.getByTitle('Changed 3 times')).toBeTruthy()
    fireEvent.click(a)
    expect(onOpen).toHaveBeenLastCalledWith({
      kind: 'diff',
      side: { path: 'src/a.ts', orig: undefined, staged: false },
    })
    const b = screen.getByRole('button', { name: /b\.ts/ })
    expect(b).toHaveTextContent('b.tssrc/editingno longer changed')
    expect(b).not.toHaveTextContent('×')
    fireEvent.click(b)
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'file', path: 'src/b.ts' })
    expect(screen.getByRole('button', { name: /\.env/ })).toHaveTextContent(
      'Sensitive',
    )
    const gone = screen.getByRole('button', { name: /old\.ts/ })
    expect(gone).toBeDisabled()
    expect(gone).toHaveTextContent('deleted')
    fireEvent.click(gone)
    expect(onOpen).toHaveBeenCalledTimes(2)
  })
})

describe('TouchedFilesSection', () => {
  const changes = (over: Partial<GitChanges> = {}): GitChanges => ({
    root: '/r',
    isRepo: true,
    branch: 'main',
    entries: [e('a.ts', '', 'M')],
    truncated: false,
    ...over,
  })

  it('reads the session once opened, opening a file under the root', async () => {
    mockTouched.mockResolvedValue(data([f('a.ts'), f('b.ts')]))
    let answer: (c: GitChanges) => void = () => {}
    mockChanges.mockReturnValue(
      new Promise<GitChanges>((r) => {
        answer = r
      }),
    )
    const onOpen = vi.fn()
    render(
      <TouchedFilesSection
        paneId="p1"
        agent="claude"
        sessionId="s1"
        onOpen={onOpen}
      />,
    )
    const toggle = screen.getByRole('button', { name: 'Files changed' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(mockTouched).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await act(async () => {})
    expect(mockTouched).toHaveBeenCalledWith('p1', {
      agent: 'claude',
      id: 's1',
    })
    // Before git status is read the root is not known: nothing opens
    fireEvent.click(await screen.findByRole('button', { name: /b\.ts/ }))
    expect(onOpen).not.toHaveBeenCalled()
    await act(async () => {
      answer(changes())
      await new Promise((r) => setTimeout(r, 5))
    })
    fireEvent.click(screen.getByRole('button', { name: /b\.ts/ }))
    expect(onOpen).toHaveBeenCalledWith({ kind: 'file', path: 'b.ts' }, '/r')
    expect(screen.getByRole('button', { name: /a\.ts/ })).toHaveTextContent(
      'Modified',
    )
    fireEvent.click(toggle)
    expect(screen.queryByRole('button', { name: /a\.ts/ })).toBeNull()
  })

  it('outside a repository tells no status', async () => {
    mockTouched.mockResolvedValue(data([f('a.ts')]))
    mockChanges.mockResolvedValue(changes({ isRepo: false, entries: [] }))
    render(
      <TouchedFilesSection
        paneId="p1"
        agent="codex"
        sessionId="s1"
        onOpen={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Files changed' }))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(screen.getByRole('button', { name: /a\.ts/ })).not.toHaveTextContent(
      'no longer changed',
    )
  })
})
