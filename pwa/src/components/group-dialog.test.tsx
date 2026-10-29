import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listRecentGroups,
  type RecentGroup,
  RequestError,
  removeRecentGroup,
} from '../hooks/use-mux-api'
import { tFor } from '../i18n/i18n-context'
import {
  freeGroupName,
  GroupDialog,
  groupProblem,
  MAX_GROUP_NAME_BYTES,
} from './group-dialog'

vi.mock('../hooks/use-mux-api', async (importActual) => ({
  ...(await importActual<typeof import('../hooks/use-mux-api')>()),
  listRecentGroups: vi.fn(),
  removeRecentGroup: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(listRecentGroups).mockReset()
  vi.mocked(removeRecentGroup).mockReset()
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

const setup = (onCreate = vi.fn(async () => {})) => {
  const onClose = vi.fn()
  render(<GroupDialog kind="workspace" onClose={onClose} onCreate={onCreate} />)
  return {
    onCreate,
    onClose,
    name: screen.getByLabelText('Name'),
    cwd: screen.getByLabelText('Directory (an absolute path on the host)'),
    create: screen.getByRole('button', { name: 'Create' }),
  }
}

// The isOpen function the dialog handed to its first create
const isOpenArg = (fn: { mock: { calls: unknown[][] } }) =>
  fn.mock.calls[0][2] as () => boolean

describe('GroupDialog', () => {
  it('creates with the trimmed name and directory, then closes', async () => {
    const { onCreate, onClose, name, cwd, create } = setup()
    expect(screen.getByText('New workspace')).toBeInTheDocument()
    fireEvent.change(name, { target: { value: ' api ' } })
    fireEvent.change(cwd, { target: { value: ' /srv/api ' } })
    await act(async () => fireEvent.click(create))
    expect(onCreate).toHaveBeenCalledWith(
      'api',
      '/srv/api',
      expect.any(Function),
    )
    // Still open when the reply came
    expect(isOpenArg(onCreate)()).toBe(true)
    expect(onClose).toHaveBeenCalled()
  })

  it('asks for a name, and for one of at most 64 bytes, before sending', async () => {
    const { onCreate, name, create } = setup()
    await act(async () => fireEvent.click(create))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name')
    fireEvent.change(name, { target: { value: 'é'.repeat(33) } })
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => fireEvent.click(create))
    expect(screen.getByRole('alert')).toHaveTextContent('Use at most 64 bytes')
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('says why the server refused and keeps what was typed', async () => {
    const onCreate = vi.fn(async () => {
      throw new RequestError(400, 'not_found', 'no such directory')
    })
    const { onClose, name, cwd, create } = setup(onCreate)
    fireEvent.change(name, { target: { value: 'api' } })
    fireEvent.change(cwd, { target: { value: '/nope' } })
    await act(async () => fireEvent.click(create))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'No such directory on the host',
    )
    expect(name).toHaveValue('api')
    expect(cwd).toHaveValue('/nope')
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.change(cwd, { target: { value: '/srv' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a reply lost on the way says the group may exist', async () => {
    const { name, create } = setup(
      vi.fn(async () => Promise.reject(new TypeError('fetch'))),
    )
    fireEvent.change(name, { target: { value: 'api' } })
    await act(async () => fireEvent.click(create))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The workspace may have been created. Check the list.',
    )
  })

  it('Cancel closes, and a reply after that shows nothing', async () => {
    let reject!: (e: unknown) => void
    const onCreate = vi.fn(() => new Promise<void>((_, r) => (reject = r)))
    const { onClose, name, create } = setup(onCreate)
    fireEvent.change(name, { target: { value: 'api' } })
    fireEvent.click(create)
    // A second press, or Enter, while sending does nothing
    fireEvent.click(create)
    fireEvent.submit(create.closest('form')!)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => reject(new RequestError(409, 'exists', 'x')))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('a create that ends after Cancel does not close again', async () => {
    let resolve!: () => void
    const onCreate = vi.fn(() => new Promise<void>((r) => (resolve = r)))
    const { onClose, name, create } = setup(onCreate)
    fireEvent.change(name, { target: { value: 'api' } })
    fireEvent.click(create)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    // The create learns the box is closed
    expect(isOpenArg(onCreate)()).toBe(false)
    await act(async () => resolve())
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

const recentGroup = (i: number, name = `g${i}`): RecentGroup => ({
  id: i.toString(16).padStart(16, '0'),
  name,
  cwd: `/srv/${name}`,
})

// The dialog with the recent groups list on, over what the server answers
const setupRecent = async (
  groups: RecentGroup[],
  { readOnly = false, takenNames = [] as string[] } = {},
) => {
  vi.mocked(listRecentGroups).mockResolvedValue({ groups, readOnly })
  const onCreate = vi.fn(async () => {})
  const onClose = vi.fn()
  const view = render(
    <GroupDialog
      kind="tmux"
      recent
      takenNames={takenNames}
      onClose={onClose}
      onCreate={onCreate}
    />,
  )
  await act(async () => {})
  return {
    ...view,
    onCreate,
    onClose,
    name: screen.getByLabelText('Name'),
    cwd: screen.getByLabelText('Directory (an absolute path on the host)'),
    list: () => screen.queryByRole('region', { name: 'Recent' }),
    use: (g: RecentGroup) =>
      screen.getByRole('button', { name: `Use ${g.name} in ${g.cwd}` }),
    remove: (g: RecentGroup) =>
      screen.getByRole('button', { name: `Remove ${g.name} from recent` }),
  }
}

describe('GroupDialog recent groups', () => {
  it('asks for nothing when the server keeps none', () => {
    setup()
    expect(listRecentGroups).not.toHaveBeenCalled()
    expect(screen.queryByTestId('recent-groups-loading')).toBeNull()
  })

  it('holds the place while loading, then lists them above the name', async () => {
    let answer!: (v: { groups: RecentGroup[]; readOnly: boolean }) => void
    vi.mocked(listRecentGroups).mockReturnValue(
      new Promise((r) => (answer = r)),
    )
    render(
      <GroupDialog kind="tmux" recent onClose={vi.fn()} onCreate={vi.fn()} />,
    )
    expect(screen.getByTestId('recent-groups-loading')).toBeInTheDocument()
    await act(async () => answer({ groups: [recentGroup(1)], readOnly: false }))
    expect(screen.queryByTestId('recent-groups-loading')).toBeNull()
    const list = screen.getByRole('region', { name: 'Recent' })
    const name = screen.getByLabelText('Name')
    expect(
      list.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(within(list).getByText('g1')).toBeInTheDocument()
    expect(within(list).getByText('/srv/g1')).toHaveAttribute(
      'title',
      '/srv/g1',
    )
  })

  it('shows nothing for an empty list or one that failed to load', async () => {
    const { list, unmount } = await setupRecent([])
    expect(list()).toBeNull()
    expect(screen.queryByTestId('recent-groups-loading')).toBeNull()
    unmount()
    vi.mocked(listRecentGroups).mockRejectedValue(new Error('offline'))
    render(
      <GroupDialog kind="tmux" recent onClose={vi.fn()} onCreate={vi.fn()} />,
    )
    await act(async () => {})
    expect(screen.queryByRole('region', { name: 'Recent' })).toBeNull()
    expect(screen.queryByTestId('recent-groups-loading')).toBeNull()
  })

  it('shows five, and the rest on Show more', async () => {
    const groups = [1, 2, 3, 4, 5, 6].map((i) => recentGroup(i))
    const { list } = await setupRecent(groups)
    expect(within(list()!).getAllByRole('listitem')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }))
    expect(within(list()!).getAllByRole('listitem')).toHaveLength(6)
    expect(screen.queryByRole('button', { name: /^Show/ })).toBeNull()
  })

  it('has no Show more for five', async () => {
    await setupRecent([1, 2, 3, 4, 5].map((i) => recentGroup(i)))
    expect(screen.queryByRole('button', { name: /^Show/ })).toBeNull()
  })

  it('fills in both fields, and Create sends them', async () => {
    const g = recentGroup(1, 'api')
    const { use, name, cwd, onCreate } = await setupRecent([g])
    fireEvent.change(name, { target: { value: 'typed' } })
    fireEvent.click(use(g))
    expect(name).toHaveValue('api')
    expect(cwd).toHaveValue('/srv/api')
    expect(name).toHaveFocus()
    expect(onCreate).not.toHaveBeenCalled()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Create' })),
    )
    expect(onCreate).toHaveBeenCalledWith(
      'api',
      '/srv/api',
      expect.any(Function),
    )
  })

  it('fills in a free name when an open group has it', async () => {
    const g = recentGroup(1, 'api')
    const { use, name } = await setupRecent([g], {
      takenNames: ['api', 'api-2', 'web'],
    })
    fireEvent.click(use(g))
    expect(name).toHaveValue('api-3')
  })

  it('a pick clears the problem shown', async () => {
    const g = recentGroup(1, 'api')
    const { use } = await setupRecent([g])
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Create' })),
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(use(g))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('removes one, also when another device did already', async () => {
    const [a, b] = [recentGroup(1), recentGroup(2)]
    vi.mocked(removeRecentGroup)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new RequestError(404, 'unknown_recent', 'gone'))
    const { remove, list } = await setupRecent([a, b])
    await act(async () => fireEvent.click(remove(a)))
    expect(removeRecentGroup).toHaveBeenCalledWith(a.id)
    expect(within(list()!).queryByText('g1')).toBeNull()
    await act(async () => fireEvent.click(remove(b)))
    expect(list()).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('puts a refused removal back where it was, and says so', async () => {
    const groups = [1, 2, 3].map((i) => recentGroup(i))
    let refuse!: (e: unknown) => void
    let allow!: () => void
    vi.mocked(removeRecentGroup)
      .mockReturnValueOnce(new Promise((_, r) => (refuse = r)))
      .mockReturnValueOnce(new Promise<void>((r) => (allow = r)))
    const { remove, list } = await setupRecent(groups)
    // Two at once: the first refused after the second was removed
    fireEvent.click(remove(groups[1]))
    fireEvent.click(remove(groups[2]))
    await act(async () => allow())
    await act(async () => refuse(new RequestError(500, '', 'failed')))
    expect(
      within(list()!)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['g1/srv/g1', 'g2/srv/g2'])
    expect(screen.getByRole('status')).toHaveTextContent(
      'Could not remove it. Try again.',
    )
    // The next removal clears it
    vi.mocked(removeRecentGroup).mockResolvedValueOnce()
    await act(async () => fireEvent.click(remove(groups[0])))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('a refused removal after the box closed changes nothing', async () => {
    let refuse!: (e: unknown) => void
    vi.mocked(removeRecentGroup).mockReturnValueOnce(
      new Promise((_, r) => (refuse = r)),
    )
    const g = recentGroup(1)
    const { remove } = await setupRecent([g])
    fireEvent.click(remove(g))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => refuse(new Error('offline')))
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('has no remove button when a newer version saved them', async () => {
    const g = recentGroup(1)
    await setupRecent([g], { readOnly: true })
    expect(screen.getByRole('button', { name: /^Use g1/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull()
  })

  it('a list that comes after the box closed shows nothing', async () => {
    let answer!: (v: { groups: RecentGroup[]; readOnly: boolean }) => void
    let fail!: (e: unknown) => void
    vi.mocked(listRecentGroups)
      .mockReturnValueOnce(new Promise((r) => (answer = r)))
      .mockReturnValueOnce(new Promise((_, r) => (fail = r)))
    const props = { kind: 'tmux' as const, onCreate: vi.fn() }
    render(<GroupDialog {...props} recent onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => answer({ groups: [recentGroup(1)], readOnly: false }))
    expect(screen.queryByRole('region', { name: 'Recent' })).toBeNull()
    expect(screen.getByTestId('recent-groups-loading')).toBeInTheDocument()
    render(<GroupDialog {...props} recent onClose={vi.fn()} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[1])
    await act(async () => fail(new Error('offline')))
    expect(screen.getAllByTestId('recent-groups-loading')).toHaveLength(2)
  })

  it('shows hidden characters as marks', async () => {
    const g = { ...recentGroup(1), name: 'a\u202eb', cwd: '/srv/\u200bx' }
    await setupRecent([g])
    expect(screen.getByText('a⟨U+202E⟩b')).toBeInTheDocument()
    expect(screen.getByText('/srv/⟨U+200B⟩x')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Remove a⟨U+202E⟩b from recent' }),
    ).toBeInTheDocument()
  })
})

describe('freeGroupName', () => {
  it('keeps a free name, else adds the first free number', () => {
    expect(freeGroupName('api', ['web'])).toBe('api')
    expect(freeGroupName('api', ['api'])).toBe('api-2')
    expect(freeGroupName('api', ['api', 'api-2'])).toBe('api-3')
  })

  it('gives up when no numbered name fits', () => {
    const long = 'a'.repeat(MAX_GROUP_NAME_BYTES - 1)
    expect(freeGroupName(long, [long])).toBe('')
    const fits = 'a'.repeat(MAX_GROUP_NAME_BYTES - 2)
    expect(freeGroupName(fits, [fits])).toBe(`${fits}-2`)
  })
})

describe('groupProblem', () => {
  it('a workspace name has no character list', () => {
    expect(groupProblem('invalid_name', 'workspace', tFor('en'))).toBe(
      "This name can't be used",
    )
  })

  it('words every code the server sends', () => {
    for (const [code, text] of [
      [
        'invalid_name',
        "This name can't be used. Avoid : . * ? [ \\ and a leading = or -",
      ],
      ['invalid_cwd', 'Enter an absolute path on the host, or leave it empty'],
      ['not_found', 'No such directory on the host'],
      ['not_directory', 'That path is a file, not a directory'],
      ['not_allowed', "A tmux session can't start in that directory"],
      ['busy', 'The directory did not answer. Try again'],
      ['exists', 'A tmux session of that name already exists'],
      ['unsupported', "This server can't create a tmux session"],
      ['', 'Could not create the tmux session'],
    ]) {
      expect(groupProblem(code, 'tmux', tFor('en'))).toBe(text)
    }
  })
})
