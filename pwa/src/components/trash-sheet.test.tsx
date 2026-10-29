import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError, type TrashEntry } from '../hooks/use-mux-api'
import { renderWithLocale } from '../i18n/test-utils'
import { TrashButton, TrashSheet } from './trash-sheet'

const mockList = vi.fn()
const mockPurge = vi.fn()
const mockEmpty = vi.fn()
const mockRestore = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchTrash: (...a: unknown[]) => mockList(...a),
  deleteTrashEntry: (...a: unknown[]) => mockPurge(...a),
  emptyTrash: (...a: unknown[]) => mockEmpty(...a),
  restoreFile: (...a: unknown[]) => mockRestore(...a),
}))

const HOUR = 3_600_000
const entry = (
  id: string,
  path: string,
  over: Partial<TrashEntry> = {},
): TrashEntry => ({
  trashId: id,
  path,
  kind: 'file',
  deletedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 7 * 24 * HOUR).toISOString(),
  size: 2048,
  ...over,
})

const A = entry('a', 'src/a.ts')
const ENV = entry('e', '.env', { sensitive: true })
const DIR = entry('d', 'old', {
  kind: 'dir',
  size: 0,
  deletedAt: new Date(Date.now() - 3 * 24 * HOUR).toISOString(),
})
const DISCARD = entry('x', 'b.md', { kind: 'discard' })

function sheet(over: Partial<Parameters<typeof TrashSheet>[0]> = {}) {
  const p = {
    isOpen: true,
    onDismiss: vi.fn(),
    target: { paneId: '%1', place: 'p1' },
    root: '/r',
    notify: vi.fn(),
    onRestored: vi.fn(),
    onRootChanged: vi.fn(),
    ...over,
  }
  const view = render(<TrashSheet {...p} />)
  return { ...p, ...view }
}

async function open(over: Partial<Parameters<typeof TrashSheet>[0]> = {}) {
  const p = sheet(over)
  await act(async () => {})
  return p
}

const rows = () =>
  within(screen.getByRole('list', { name: 'Deleted items' })).queryAllByRole(
    'listitem',
  )
const confirmBox = () =>
  within(screen.getByRole('dialog', { name: /\?$|sensitive/ }))

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
  mockList.mockReset()
  mockPurge.mockReset()
  mockEmpty.mockReset()
  mockRestore.mockReset()
  mockList.mockResolvedValue({ root: '/r', entries: [A, ENV, DIR, DISCARD] })
})
afterEach(cleanup)

describe('TrashButton', () => {
  it('is a labelled button', () => {
    const onClick = vi.fn()
    render(<TrashButton onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }))
    expect(onClick).toHaveBeenCalled()
  })
})

describe('TrashSheet', () => {
  it('lists the root it is given each time it opens', async () => {
    const p = await open()
    expect(mockList).toHaveBeenCalledWith({ paneId: '%1', place: 'p1' }, '/r')
    expect(rows()).toHaveLength(4)
    const first = rows()[0]
    expect(within(first).getByText('a.ts')).toBeInTheDocument()
    expect(within(first).getByText('src/')).toBeInTheDocument()
    expect(first.textContent).toContain('File · 5 minutes ago · 2.0 KiB')
    expect(first.textContent).toContain('Removed by')
    expect(within(rows()[1]).getByLabelText('Sensitive')).toBeInTheDocument()
    // A folder has no size
    expect(rows()[2].textContent).toContain('Folder · ')
    expect(rows()[2].textContent).not.toContain('KB')
    expect(rows()[2].textContent).toContain('3 days ago')
    expect(rows()[3].textContent).toContain('Discarded change')
    expect(rows()[3].textContent).toContain(
      "replaces the file's current content",
    )
    expect(
      screen.getByText(/Only what was deleted while this folder was the root/),
    ).toBeInTheDocument()
    expect(screen.queryByText('Showing the 500 newest')).toBeNull()
    // Closed, then opened again: read again
    p.rerender(<TrashSheet {...p} isOpen={false} />)
    p.rerender(<TrashSheet {...p} isOpen />)
    await act(async () => {})
    expect(mockList).toHaveBeenCalledTimes(2)
  })

  it('speaks Vietnamese when the app does', async () => {
    renderWithLocale(
      <TrashSheet
        isOpen
        onDismiss={vi.fn()}
        target={{ paneId: '%1' }}
        root="/r"
        notify={vi.fn()}
        onRestored={vi.fn()}
        onRootChanged={vi.fn()}
      />,
      'vi',
    )
    await act(async () => {})
    const list = screen.getByRole('list', { name: 'Các mục đã xoá' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(4)
    expect(list.textContent).toContain('Thư mục')
    expect(
      screen.getByRole('button', { name: 'Dọn sạch thùng rác' }),
    ).toBeInTheDocument()
  })

  it('reads nothing while closed', async () => {
    await open({ isOpen: false })
    expect(mockList).not.toHaveBeenCalled()
  })

  it('says when it is empty, or cut to the 500 newest', async () => {
    mockList.mockResolvedValueOnce({ root: '/r', entries: [] })
    const p = await open()
    expect(screen.getByText(/The trash is empty/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Empty trash' })).toBeNull()
    p.unmount()
    mockList.mockResolvedValueOnce({
      root: '/r',
      entries: [A],
      truncated: true,
    })
    await open()
    expect(screen.getByText('Showing the 500 newest')).toBeInTheDocument()
  })

  it('shows unsafe characters in a name as marks', async () => {
    mockList.mockResolvedValueOnce({
      root: '/r',
      entries: [entry('u', 'd‮x/a‮b.txt')],
    })
    await open()
    expect(within(rows()[0]).getByText('a⟨U+202E⟩b.txt')).toBeInTheDocument()
    expect(within(rows()[0]).getByText('d⟨U+202E⟩x/')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Restore a⟨U+202E⟩b.txt' }),
    ).toBeInTheDocument()
  })

  it('a list that fails can be read again', async () => {
    mockList.mockRejectedValueOnce(new Error('offline'))
    await open()
    expect(screen.getByText("The trash can't be read")).toBeInTheDocument()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Try again' })),
    )
    expect(rows()).toHaveLength(4)
  })

  it('a moved root closes it and is followed', async () => {
    mockList.mockRejectedValueOnce(
      new RequestError(409, '', 'root changed', { root: '/n' }),
    )
    const p = await open()
    expect(p.onDismiss).toHaveBeenCalled()
    expect(p.onRootChanged).toHaveBeenCalledWith('/n')
  })

  it('restores an entry, which leaves the list', async () => {
    mockRestore.mockResolvedValue({ root: '/r', path: 'src/a.ts' })
    const p = await open()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Restore a.ts' })),
    )
    expect(mockRestore).toHaveBeenCalledWith(
      { paneId: '%1', place: 'p1' },
      { root: '/r', trashId: 'a', reveal: false },
    )
    expect(p.onRestored).toHaveBeenCalledWith(A, 'src/a.ts')
    expect(p.notify).toHaveBeenLastCalledWith('Restored a.ts', {
      variant: 'success',
    })
    expect(rows()).toHaveLength(3)
  })

  it('asks before restoring a sensitive file, then reveals it', async () => {
    mockRestore.mockResolvedValue({ root: '/r', path: '.env' })
    const p = await open()
    fireEvent.click(screen.getByRole('button', { name: 'Restore .env' }))
    expect(mockRestore).not.toHaveBeenCalled()
    // Cancelled: nothing sent
    fireEvent.click(confirmBox().getByRole('button', { name: 'Cancel' }))
    expect(mockRestore).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Restore .env' }))
    expect(confirmBox().getByText('.env may contain secrets. Restore it?'))
    await act(async () =>
      fireEvent.click(confirmBox().getByRole('button', { name: 'Restore' })),
    )
    expect(mockRestore.mock.calls[0][1]).toEqual({
      root: '/r',
      trashId: 'e',
      reveal: true,
    })
    expect(p.onRestored).toHaveBeenCalledWith(ENV, '.env')
  })

  it('restores the text a discard replaced', async () => {
    mockRestore.mockResolvedValue({ root: '/r', path: 'b.md' })
    const p = await open()
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Restore the discarded text of b.md',
        }),
      ),
    )
    expect(p.onRestored).toHaveBeenCalledWith(DISCARD, 'b.md')
  })

  it('says why a restore failed', async () => {
    mockRestore
      .mockRejectedValueOnce(new RequestError(409, 'changed', 'x'))
      .mockRejectedValueOnce(
        new RequestError(409, 'exists', 'x', { path: 'src/a.ts' }),
      )
      .mockRejectedValueOnce(new Error('offline'))
    const p = await open()
    const restore = () =>
      act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Restore a.ts' })),
      )
    await restore()
    expect(p.notify).toHaveBeenLastCalledWith(
      'a.ts changed since; not restored',
      {
        variant: 'warning',
      },
    )
    await restore()
    expect(p.notify).toHaveBeenLastCalledWith(
      'A file now exists at src/a.ts; not restored',
      { variant: 'warning' },
    )
    await restore()
    expect(p.notify).toHaveBeenLastCalledWith('Could not restore a.ts', {
      variant: 'danger',
    })
    expect(rows()).toHaveLength(4)
  })

  it('an entry gone elsewhere leaves the list, said neutrally', async () => {
    mockRestore.mockRejectedValueOnce(
      new RequestError(404, 'not_in_trash', 'x'),
    )
    mockPurge.mockRejectedValueOnce(new RequestError(404, 'not_in_trash', 'x'))
    const p = await open()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Restore a.ts' })),
    )
    expect(p.notify).toHaveBeenLastCalledWith('Already restored or removed', {
      variant: 'info',
    })
    expect(rows()).toHaveLength(3)
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete old permanently' }),
    )
    await act(async () =>
      fireEvent.click(
        confirmBox().getByRole('button', { name: 'Delete permanently' }),
      ),
    )
    expect(p.notify).toHaveBeenLastCalledWith('Already restored or removed', {
      variant: 'info',
    })
    expect(rows()).toHaveLength(2)
  })

  it('a moved root on a restore or a delete closes the sheet', async () => {
    mockRestore.mockRejectedValueOnce(
      new RequestError(409, '', 'root changed', { root: '/n' }),
    )
    mockPurge.mockRejectedValueOnce(
      new RequestError(409, '', 'root changed', { root: '/m' }),
    )
    const p = await open()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Restore a.ts' })),
    )
    expect(p.onRootChanged).toHaveBeenLastCalledWith('/n')
    expect(p.onDismiss).toHaveBeenCalledTimes(1)
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete a.ts permanently' }),
    )
    await act(async () =>
      fireEvent.click(
        confirmBox().getByRole('button', { name: 'Delete permanently' }),
      ),
    )
    expect(p.onRootChanged).toHaveBeenLastCalledWith('/m')
    expect(p.onDismiss).toHaveBeenCalledTimes(2)
  })

  it('deletes an entry for good after asking, Cancel first', async () => {
    mockPurge
      .mockResolvedValueOnce({ root: '/r', trashId: 'a' })
      .mockRejectedValueOnce(new RequestError(503, 'trash_unavailable', 'x'))
    const p = await open()
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete a.ts permanently' }),
    )
    expect(
      confirmBox().getByText('a.ts will be deleted. This cannot be undone.'),
    ).toBeInTheDocument()
    await act(async () =>
      fireEvent.click(
        confirmBox().getByRole('button', { name: 'Delete permanently' }),
      ),
    )
    expect(mockPurge).toHaveBeenCalledWith(
      { paneId: '%1', place: 'p1' },
      { root: '/r', trashId: 'a' },
    )
    expect(p.notify).toHaveBeenLastCalledWith('Deleted a.ts permanently')
    expect(rows()).toHaveLength(3)
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete .env permanently' }),
    )
    await act(async () =>
      fireEvent.click(
        confirmBox().getByRole('button', { name: 'Delete permanently' }),
      ),
    )
    expect(p.notify).toHaveBeenLastCalledWith('Could not delete .env', {
      variant: 'danger',
    })
    expect(rows()).toHaveLength(3)
  })

  it('empties exactly the entries shown, then reads the list again', async () => {
    mockEmpty.mockResolvedValueOnce({ root: '/r', removed: 4, failed: 0 })
    const p = await open()
    fireEvent.click(screen.getByRole('button', { name: 'Empty trash' }))
    expect(
      confirmBox().getByText(
        'All 4 items shown will be deleted. This cannot be undone.',
      ),
    ).toBeInTheDocument()
    mockList.mockResolvedValueOnce({ root: '/r', entries: [] })
    await act(async () =>
      fireEvent.click(
        confirmBox().getByRole('button', { name: 'Empty trash' }),
      ),
    )
    expect(mockEmpty).toHaveBeenCalledWith(
      { paneId: '%1', place: 'p1' },
      { root: '/r', trashIds: ['a', 'e', 'd', 'x'] },
    )
    expect(p.notify).toHaveBeenLastCalledWith('Deleted 4 permanently', {
      variant: 'info',
    })
    expect(mockList).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/The trash is empty/)).toBeInTheDocument()
  })

  it('says how many could not go, and what a cut list empties', async () => {
    mockList.mockResolvedValueOnce({
      root: '/r',
      entries: [A],
      truncated: true,
    })
    mockEmpty
      .mockResolvedValueOnce({ root: '/r', removed: 0, failed: 1 })
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(
        new RequestError(409, '', 'root changed', { root: '/n' }),
      )
    const p = await open()
    const empty = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Empty trash' }))
      await act(async () =>
        fireEvent.click(
          confirmBox().getByRole('button', { name: 'Empty trash' }),
        ),
      )
    }
    fireEvent.click(screen.getByRole('button', { name: 'Empty trash' }))
    expect(
      confirmBox().getByText(
        'Only the 1 newest items, the ones shown, will be deleted; older ones stay. This cannot be undone.',
      ),
    ).toBeInTheDocument()
    fireEvent.click(confirmBox().getByRole('button', { name: 'Cancel' }))
    expect(mockEmpty).not.toHaveBeenCalled()
    await empty()
    expect(p.notify).toHaveBeenLastCalledWith(
      '1 of them could not be deleted; try again',
      { variant: 'warning' },
    )
    await empty()
    expect(p.notify).toHaveBeenLastCalledWith('Could not empty the trash', {
      variant: 'danger',
    })
    await empty()
    expect(p.onRootChanged).toHaveBeenCalledWith('/n')
  })

  it('empties the entries shown when asked, even if the list changed since', async () => {
    mockEmpty.mockResolvedValueOnce({ root: '/s', removed: 0, failed: 0 })
    const p = await open()
    fireEvent.click(screen.getByRole('button', { name: 'Empty trash' }))
    mockList.mockResolvedValueOnce({ root: '/s', entries: [DIR] })
    p.rerender(<TrashSheet {...p} root="/s" />)
    await act(async () => {})
    expect(rows()).toHaveLength(1)
    await act(async () =>
      fireEvent.click(
        confirmBox().getByRole('button', { name: 'Empty trash' }),
      ),
    )
    expect(mockEmpty.mock.calls[0][1].trashIds).toEqual(['a', 'e', 'd', 'x'])
  })

  it('drops the answers of a list or a restore made for another root', async () => {
    let answer: (v: unknown) => void = () => {}
    let refuse: (e: unknown) => void = () => {}
    mockList
      .mockReset()
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      .mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)))
      .mockResolvedValueOnce({ root: '/t', entries: [A] })
    const p = await open()
    p.rerender(<TrashSheet {...p} root="/s" />)
    p.rerender(<TrashSheet {...p} root="/t" />)
    await act(async () => {})
    expect(rows()).toHaveLength(1)
    // The answers for /r and /s come late: ignored
    await act(async () => {
      answer({ root: '/r', entries: [A, ENV, DIR] })
      refuse(new RequestError(409, '', 'root changed', { root: '/n' }))
    })
    expect(rows()).toHaveLength(1)
    expect(p.onRootChanged).not.toHaveBeenCalled()

    // A restore answered while the list reads again: nothing to drop yet
    let restored: (v: unknown) => void = () => {}
    mockRestore.mockReturnValueOnce(
      new Promise((resolve) => (restored = resolve)),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Restore a.ts' }))
    mockList.mockReturnValueOnce(new Promise(() => {}))
    p.rerender(<TrashSheet {...p} root="/u" />)
    await act(async () => restored({ root: '/t', path: 'src/a.ts' }))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(p.onRestored).toHaveBeenCalledWith(A, 'src/a.ts')
  })

  it('a second press of a confirm button does nothing more', async () => {
    mockPurge.mockResolvedValue({ root: '/r', trashId: 'a' })
    await open()
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete a.ts permanently' }),
    )
    const button = confirmBox().getByRole('button', {
      name: 'Delete permanently',
    })
    await act(async () => {
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(mockPurge).toHaveBeenCalledTimes(1)
  })

  it('a single entry shown is named as one', async () => {
    mockList.mockResolvedValueOnce({ root: '/r', entries: [A] })
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Empty trash' }))
    expect(
      confirmBox().getByText(
        'The 1 item shown will be deleted. This cannot be undone.',
      ),
    ).toBeInTheDocument()
  })
})
