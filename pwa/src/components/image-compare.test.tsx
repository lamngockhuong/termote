import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type ChangeEntry, RequestError } from '../hooks/use-mux-api'
import { ImageCompare, imageSides } from './image-compare'

const mockImage = vi.fn()
vi.mock('../hooks/use-mux-api', async (orig) => ({
  ...(await orig<typeof import('../hooks/use-mux-api')>()),
  fetchFileImage: (...a: unknown[]) => mockImage(...a),
}))

const entry = (over: Partial<ChangeEntry> = {}): ChangeEntry => ({
  path: 'img/b.png',
  staged: '',
  unstaged: 'M',
  sensitive: false,
  ...over,
})

type Props = Parameters<typeof ImageCompare>[0]
function show(over: Partial<Props> = {}) {
  const props: Props = {
    paneId: '%1',
    entry: entry(),
    staged: false,
    root: '/r',
    reveal: false,
    version: 'M',
    reload: 0,
    oneColumn: false,
    onRootChanged: vi.fn(),
    onSensitive: vi.fn(),
    ...over,
  }
  const view = render(<ImageCompare {...props} />)
  return {
    ...props,
    ...view,
    again: (o: Partial<Props>) =>
      view.rerender(<ImageCompare {...props} {...o} />),
  }
}

// The sides each read asked for
const sidesRead = () =>
  mockImage.mock.calls.map((c) => (c[2] as { side: string }).side)

let made = 0
beforeEach(() => {
  made = 0
  mockImage.mockReset()
  mockImage.mockImplementation(async () => new Blob(['x']))
  URL.createObjectURL = vi.fn(() => `blob:u${++made}`)
  URL.revokeObjectURL = vi.fn()
})

describe('imageSides', () => {
  it.each<
    [string, Partial<ChangeEntry>, boolean, ReturnType<typeof imageSides>]
  >([
    ['.M', { unstaged: 'M' }, false, { old: { orig: false }, new: true }],
    [
      'M.',
      { staged: 'M', unstaged: '' },
      true,
      { old: { orig: false }, new: true },
    ],
    ['MM staged', { staged: 'M' }, true, { old: { orig: false }, new: true }],
    [
      'MM unstaged',
      { staged: 'M' },
      false,
      { old: { orig: false }, new: true },
    ],
    ['?', { unstaged: '?' }, false, { old: null, new: true }],
    ['A.', { staged: 'A', unstaged: '' }, true, { old: null, new: true }],
    ['.A', { unstaged: 'A' }, false, { old: null, new: true }],
    [
      'D.',
      { staged: 'D', unstaged: '' },
      true,
      { old: { orig: false }, new: false },
    ],
    ['.D', { unstaged: 'D' }, false, { old: { orig: false }, new: false }],
    [
      'R.',
      { staged: 'R', unstaged: '', orig: 'a.png' },
      true,
      { old: { orig: true }, new: true },
    ],
    [
      'C.',
      { staged: 'C', unstaged: '', orig: 'a.png' },
      true,
      { old: { orig: true }, new: true },
    ],
    [
      'RM unstaged',
      { staged: 'R', orig: 'a.png' },
      false,
      { old: { orig: false }, new: true },
    ],
    [
      '.R',
      { unstaged: 'R', orig: 'a.png' },
      false,
      { old: { orig: true }, new: true },
    ],
    [
      '.C',
      { unstaged: 'C', orig: 'a.png' },
      false,
      { old: { orig: true }, new: true },
    ],
    [
      'conflict',
      { unstaged: '', conflict: true },
      false,
      { old: null, new: true },
    ],
  ])('%s', (_, over, staged, want) => {
    expect(imageSides(entry(over), staged)).toEqual(want)
  })
})

describe('ImageCompare', () => {
  it('shows the index and the working tree side by side', async () => {
    const { container } = show()
    expect(await screen.findAllByRole('img')).toHaveLength(2)
    expect(screen.getByText('Before · Index')).toBeInTheDocument()
    expect(screen.getByText('After · Working tree')).toBeInTheDocument()
    expect(container.querySelector('.grid-cols-2')).not.toBeNull()
    expect(mockImage).toHaveBeenCalledWith(
      '%1',
      'img/b.png',
      {
        side: 'old',
        staged: false,
        orig: undefined,
        root: '/r',
        reveal: false,
      },
      expect.any(AbortSignal),
    )
    expect(sidesRead().sort()).toEqual(['new', 'old'])
  })

  it('stacks on a phone, and names HEAD and the index when staged', async () => {
    const { container } = show({
      staged: true,
      oneColumn: true,
      entry: entry({ staged: 'M', unstaged: '' }),
    })
    expect(await screen.findAllByRole('img')).toHaveLength(2)
    expect(screen.getByText('Before · HEAD')).toBeInTheDocument()
    expect(screen.getByText('After · Index')).toBeInTheDocument()
    expect(container.querySelector('.grid-cols-1')).not.toBeNull()
  })

  it('reads one side of an added or deleted image', async () => {
    const { again } = show({ entry: entry({ unstaged: 'A' }) })
    expect(await screen.findAllByRole('img')).toHaveLength(1)
    expect(screen.getByText('Added')).toBeInTheDocument()
    expect(sidesRead()).toEqual(['new'])
    mockImage.mockClear()
    again({ entry: entry({ unstaged: 'D' }), version: 'D' })
    expect(await screen.findByText('Deleted')).toBeInTheDocument()
    await waitFor(() => expect(sidesRead()).toEqual(['old']))
  })

  it('says Added when the server has no old version after all', async () => {
    mockImage.mockImplementation(async (_p, _path, q: { side: string }) => {
      if (q.side === 'old') throw new RequestError(404, 'no_version', 'none')
      return new Blob(['x'])
    })
    show()
    expect(await screen.findByText('Added')).toBeInTheDocument()
  })

  it('names the source of a rename on the side that reads it', async () => {
    const renamed = entry({ staged: 'R', unstaged: '', orig: 'img/a.png' })
    const { again } = show({ staged: true, entry: renamed })
    expect(
      await screen.findByText('Before · HEAD · img/a.png'),
    ).toBeInTheDocument()
    expect(mockImage.mock.calls[0][2]).toMatchObject({ orig: 'img/a.png' })
    // The unstaged side of RM reads the index under the new name
    again({ staged: false, entry: { ...renamed, unstaged: 'M' } })
    expect(await screen.findByText('Before · Index')).toBeInTheDocument()
  })

  it('shows only the working tree of a conflict, with a warning', async () => {
    show({ entry: entry({ unstaged: '', conflict: true }) })
    expect(screen.getByText(/Unresolved conflict/)).toBeInTheDocument()
    expect(await screen.findAllByRole('img')).toHaveLength(1)
    expect(sidesRead()).toEqual(['new'])
    // No Before side at all: nothing was added
    expect(screen.queryByText(/Before/)).toBeNull()
    expect(screen.queryByText('Added')).toBeNull()
  })

  it('reads again on a refresh or a new version, not on a poll', async () => {
    const { again } = show()
    await screen.findAllByRole('img')
    expect(mockImage).toHaveBeenCalledTimes(2)
    // A poll: a new entry object, the same version
    again({ entry: entry() })
    expect(mockImage).toHaveBeenCalledTimes(2)
    again({ reload: 1 })
    await waitFor(() => expect(mockImage).toHaveBeenCalledTimes(4))
    again({ reload: 1, version: 'MM' })
    await waitFor(() => expect(mockImage).toHaveBeenCalledTimes(6))
  })

  it('retries one busy side alone', async () => {
    mockImage.mockImplementation(async (_p, _path, q: { side: string }) => {
      if (q.side === 'new') throw new RequestError(429, 'busy', 'busy')
      return new Blob(['x'])
    })
    show()
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(sidesRead()).toEqual(['old', 'new', 'new']))
  })

  it('asks the caller to confirm a name the server finds sensitive', async () => {
    mockImage.mockRejectedValue(new RequestError(403, 'sensitive', 'sensitive'))
    const p = show()
    await waitFor(() => expect(p.onSensitive).toHaveBeenCalled())
  })

  it('hands a moved root to the caller', async () => {
    mockImage.mockRejectedValue(
      new RequestError(409, '', 'root changed', undefined, undefined, '/new'),
    )
    const p = show()
    await waitFor(() => expect(p.onRootChanged).toHaveBeenCalledWith('/new'))
  })

  it('revokes both URLs when it goes', async () => {
    const { unmount } = show()
    await screen.findAllByRole('img')
    await act(async () => unmount())
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })
})
