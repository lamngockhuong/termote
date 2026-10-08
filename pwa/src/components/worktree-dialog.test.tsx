import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RequestError, type WorktreeList } from '../hooks/use-mux-api'
import {
  WorktreeDialog,
  WorktreeRemoveDialog,
  worktreeProblem,
} from './worktree-dialog'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

const LIST: WorktreeList = {
  repoName: 'repo',
  branches: ['main', 'develop', 'feat/x'],
  worktrees: [
    {
      path: '/repo',
      branch: 'main',
      linked: false,
      openable: false,
      groupId: 'w1',
    },
    {
      path: '/wt/repo/feat-x',
      branch: 'feat/x',
      linked: true,
      openable: true,
      groupId: 'w2',
    },
    { path: '/wt/repo/old', branch: 'old', linked: true, openable: true },
    { path: '/wt/repo/gone', branch: 'gone', linked: true, openable: false },
  ],
}

type DialogProps = Parameters<typeof WorktreeDialog>[0]

const defaults = (list: WorktreeList) => ({
  mode: 'new' as DialogProps['mode'],
  groupId: 'w1',
  onClose: vi.fn(),
  onCreate: vi.fn<DialogProps['onCreate']>(async () => {}),
  onOpen: vi.fn<DialogProps['onOpen']>(async () => {}),
  onShow: vi.fn(),
  load: vi.fn(async (_groupId: string) => list),
})

const setup = (
  over: Partial<ReturnType<typeof defaults>> = {},
  list: WorktreeList = LIST,
) => {
  const props = { ...defaults(list), ...over }
  render(<WorktreeDialog {...props} />)
  return props
}

const branchInput = () =>
  screen.getByLabelText('Branch (new, or one to check out)')
const create = () => screen.getByRole('button', { name: 'Create' })
// Lets the worktree list arrive
const loaded = () => act(async () => {})

describe('WorktreeDialog — new', () => {
  it('creates from Current HEAD with the trimmed branch and label', async () => {
    const p = setup()
    await loaded()
    fireEvent.change(branchInput(), { target: { value: ' feat/new ' } })
    fireEvent.change(screen.getByLabelText('Workspace name (optional)'), {
      target: { value: ' New ' },
    })
    await act(async () => fireEvent.click(create()))
    expect(p.onCreate).toHaveBeenCalledWith(
      { groupId: 'w1', branch: 'feat/new', base: '', label: 'New' },
      expect.any(Function),
    )
    expect(p.onClose).toHaveBeenCalled()
  })

  it('creates from a base picked in the menu', async () => {
    const p = setup()
    await vi.waitFor(() =>
      screen.getByRole('button', { name: 'Base: Current HEAD' }),
    )
    fireEvent.change(branchInput(), { target: { value: 'feat/new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Base: Current HEAD' }))
    fireEvent.click(screen.getByRole('radio', { name: 'develop' }))
    await act(async () => fireEvent.click(create()))
    expect(p.onCreate.mock.calls[0][0]).toMatchObject({ base: 'develop' })
  })

  it('checks the name before sending, refusing invisible characters', async () => {
    const p = setup()
    await loaded()
    await act(async () => fireEvent.click(create()))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a branch')
    for (const bad of ['-x', 'a‮b', 'a​b', 'a b']) {
      fireEvent.change(branchInput(), { target: { value: bad } })
      await act(async () => fireEvent.click(create()))
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Not a valid branch name',
      )
    }
    expect(p.onCreate).not.toHaveBeenCalled()
  })

  it('checks the workspace name before sending', async () => {
    const p = setup()
    await loaded()
    fireEvent.change(branchInput(), { target: { value: 'feat/new' } })
    fireEvent.change(screen.getByLabelText('Workspace name (optional)'), {
      target: { value: 'a;' },
    })
    await act(async () => fireEvent.click(create()))
    expect(screen.getByRole('alert')).toHaveTextContent(
      "This workspace name can't be used",
    )
    expect(p.onCreate).not.toHaveBeenCalled()
  })

  it('refuses a long workspace name, and sends once while sending', async () => {
    let finish = () => {}
    const onCreate = vi.fn<DialogProps['onCreate']>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    setup({ onCreate })
    await loaded()
    fireEvent.change(branchInput(), { target: { value: 'feat/new' } })
    const label = screen.getByLabelText('Workspace name (optional)')
    fireEvent.change(label, { target: { value: 'é'.repeat(33) } })
    await act(async () => fireEvent.click(create()))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Use at most 64 bytes for the label',
    )
    fireEvent.change(label, { target: { value: 'ok' } })
    const form = branchInput().closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(onCreate).toHaveBeenCalledTimes(1)
    await act(async () => finish())
  })

  it('a reply lost on the way is worded generically', async () => {
    const lost = vi.fn<DialogProps['onCreate']>(async () => {
      throw new TypeError('fetch')
    })
    setup({ onCreate: lost })
    await loaded()
    fireEvent.change(branchInput(), { target: { value: 'feat/new' } })
    await act(async () => fireEvent.click(create()))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not change the worktree',
    )
  })

  it('a refusal after Cancel shows nothing', async () => {
    let fail = () => {}
    const onCreate = vi.fn<DialogProps['onCreate']>(
      () =>
        new Promise<void>((_, reject) => {
          fail = () => reject(new RequestError(409, 'create_failed', 'x'))
        }),
    )
    const p = setup({ onCreate })
    await loaded()
    fireEvent.change(branchInput(), { target: { value: 'feat/new' } })
    fireEvent.click(create())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => fail())
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('says why the list could not be read, and still offers Create', async () => {
    setup({
      load: vi.fn(async (_groupId: string): Promise<WorktreeList> => {
        throw new RequestError(409, 'not_git', 'x')
      }),
    })
    await loaded()
    expect(
      screen.getByText('This workspace is not in a git repository'),
    ).toBeInTheDocument()
    expect(create()).toBeEnabled()
  })

  it('disables the base for an existing branch and sends none', async () => {
    const p = setup()
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Base: Current HEAD' }))
    fireEvent.click(screen.getByRole('radio', { name: 'develop' }))
    fireEvent.change(branchInput(), { target: { value: 'feat/x' } })
    expect(
      screen.getByText('Checks out the existing branch; base is not used'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Base:/ })).toBeNull()
    await act(async () => fireEvent.click(create()))
    expect(p.onCreate.mock.calls[0][0]).toMatchObject({ base: '' })
  })

  it('resets the base on branch_exists and keeps what was typed', async () => {
    const onCreate = vi.fn<DialogProps['onCreate']>(async () => {
      throw new RequestError(409, 'branch_exists', 'exists')
    })
    const p = setup({ onCreate })
    await loaded()
    fireEvent.change(branchInput(), { target: { value: 'elsewhere' } })
    fireEvent.click(screen.getByRole('button', { name: 'Base: Current HEAD' }))
    fireEvent.click(screen.getByRole('radio', { name: 'main' }))
    await act(async () => fireEvent.click(create()))
    expect(screen.getByRole('alert')).toHaveTextContent(
      worktreeProblem('branch_exists'),
    )
    expect(branchInput()).toHaveValue('elsewhere')
    expect(
      screen.getByText('Checks out the existing branch; base is not used'),
    ).toBeInTheDocument()
    expect(p.onClose).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(create()))
    expect(onCreate.mock.calls[1][0]).toMatchObject({ base: '' })
  })

  it('offers to open the worktree a failed create found', async () => {
    const onCreate = vi.fn<DialogProps['onCreate']>(async () => {
      throw new RequestError(409, 'create_failed', 'git')
    })
    const p = setup({ onCreate })
    await loaded()
    fireEvent.change(branchInput(), { target: { value: 'old' } })
    await act(async () => fireEvent.click(create()))
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Open it' })),
    )
    expect(p.onOpen).toHaveBeenCalledWith('old', expect.any(Function))
  })

  it('a reply after Cancel selects nothing', async () => {
    let finish = () => {}
    const onCreate = vi.fn<DialogProps['onCreate']>(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const p = setup({ onCreate })
    await loaded()
    fireEvent.change(branchInput(), { target: { value: 'feat/new' } })
    fireEvent.click(create())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const isOpen = onCreate.mock.calls[0][1]
    expect(isOpen()).toBe(false)
    await act(async () => finish())
    expect(p.onClose).toHaveBeenCalledTimes(1)
  })

  it('filters a long base list', async () => {
    const branches = Array.from({ length: 20 }, (_, i) => `b${i}`)
    setup({}, { ...LIST, branches })
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: 'Base: Current HEAD' }))
    fireEvent.change(screen.getByLabelText('Filter branches'), {
      target: { value: 'b1' },
    })
    // b1, b10..b19, and Current HEAD
    expect(screen.getAllByRole('radio')).toHaveLength(12)
  })
})

describe('WorktreeDialog — open', () => {
  it('lists the openable worktrees and selects one already open', async () => {
    const p = setup({ mode: 'open' })
    await vi.waitFor(() => screen.getByRole('button', { name: /feat\/x/ }))
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.queryByText('gone')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /feat\/x/ }))
    expect(p.onShow).toHaveBeenCalledWith('w2')
    expect(p.onOpen).not.toHaveBeenCalled()
  })

  it('opens a closed one', async () => {
    const p = setup({ mode: 'open' })
    await vi.waitFor(() => screen.getByRole('button', { name: /old/ }))
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /old/ })),
    )
    expect(p.onOpen).toHaveBeenCalledWith('old', expect.any(Function))
    // Still open when the reply came
    expect(p.onOpen.mock.calls[0][1]()).toBe(true)
    expect(p.onClose).toHaveBeenCalled()
  })

  it('ignores an entry without a branch', async () => {
    const p = setup(
      { mode: 'open' },
      {
        ...LIST,
        worktrees: [
          { path: '/wt/repo/headless', linked: true, openable: true },
        ],
      },
    )
    await vi.waitFor(() => screen.getByRole('button', { name: /headless/ }))
    fireEvent.click(screen.getByRole('button', { name: /headless/ }))
    expect(p.onOpen).not.toHaveBeenCalled()
    expect(p.onShow).not.toHaveBeenCalled()
  })

  it('says when there is none', async () => {
    setup({ mode: 'open' }, { ...LIST, worktrees: [LIST.worktrees[0]] })
    expect(
      await screen.findByText(
        'No other worktrees. Create one with New worktree',
      ),
    ).toBeInTheDocument()
  })

  it('words a refused list', async () => {
    setup({
      mode: 'open',
      load: vi.fn(async (_groupId: string): Promise<WorktreeList> => {
        throw new RequestError(409, 'not_git', 'not git')
      }),
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This workspace is not in a git repository',
    )
  })
})

describe('WorktreeRemoveDialog', () => {
  const renderRemove = (
    over: Partial<Parameters<typeof WorktreeRemoveDialog>[0]> = {},
    list: WorktreeList = LIST,
  ) => {
    const props = {
      groupId: 'w2',
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
      load: vi.fn(async () => list),
      ...over,
    }
    render(<WorktreeRemoveDialog {...props} />)
    return props
  }

  it('names the checkout Herdr reports and sends it', async () => {
    const p = renderRemove()
    expect(
      await screen.findByText('Remove worktree "feat/x"?'),
    ).toBeInTheDocument()
    expect(screen.getByText('/wt/repo/feat-x')).toBeInTheDocument()
    // In full, where the title may be cut short
    expect(screen.getByText('feat/x', { selector: 'span' })).toBeInTheDocument()
    // Waits for the dialog to be open (showModal runs in an effect)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove worktree' }),
    )
    expect(p.onConfirm).toHaveBeenCalledWith({
      force: false,
      path: '/wt/repo/feat-x',
      branch: 'feat/x',
    })
  })

  it('shows unsafe characters in the path', async () => {
    renderRemove(
      {},
      {
        ...LIST,
        worktrees: [{ ...LIST.worktrees[1], path: '/wt/a‮b', branch: 'feat/x' }],
      },
    )
    expect(await screen.findByText('/wt/a⟨U+202E⟩b')).toBeInTheDocument()
  })

  it('names a checkout on no branch by its folder', async () => {
    const p = renderRemove(
      {},
      {
        ...LIST,
        worktrees: [
          {
            path: '/wt/repo/detached/',
            linked: true,
            openable: false,
            groupId: 'w2',
          },
          { path: '/', linked: true, openable: false, groupId: 'w9' },
        ],
      },
    )
    expect(
      await screen.findByText('Remove worktree "detached"?'),
    ).toBeInTheDocument()
    // Waits for the dialog to be open (showModal runs in an effect)
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove worktree' }),
    )
    expect(p.onConfirm).toHaveBeenCalledWith({
      force: false,
      path: '/wt/repo/detached/',
      branch: '',
    })
  })

  it('names the root folder as it is', async () => {
    renderRemove(
      { groupId: 'w9' },
      {
        ...LIST,
        worktrees: [
          { path: '/', linked: true, openable: false, groupId: 'w9' },
        ],
      },
    )
    expect(await screen.findByText('Remove worktree "/"?')).toBeInTheDocument()
  })

  it('offers no Remove for a workspace Herdr does not manage', async () => {
    renderRemove({ groupId: 'w1' })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Herdr does not manage this worktree',
    )
    expect(screen.queryByRole('button', { name: 'Remove worktree' })).toBeNull()
  })

  it('asks a second time with force, for the same checkout', () => {
    const p = renderRemove({
      force: { path: '/wt/repo/feat-x', branch: 'feat/x' },
    })
    expect(screen.getByText(/uncommitted or untracked changes/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Remove anyway' }))
    expect(p.onConfirm).toHaveBeenCalledWith({
      force: true,
      path: '/wt/repo/feat-x',
      branch: 'feat/x',
    })
    expect(p.load).not.toHaveBeenCalled()
  })
})

describe('worktreeProblem', () => {
  it.each([
    ['invalid_name', 'Not a valid branch name'],
    ['dirty', 'Could not change the worktree'],
    ['changed', 'This worktree changed; look again'],
    ['unknown', 'Herdr is still working on it; check the list in a moment'],
    ['unknown_group', 'It no longer exists; the list was refreshed'],
    ['busy', 'Another worktree change is still running; try again'],
    [
      'unsupported',
      'This Herdr cannot manage worktrees (needs 0.9.2 or later)',
    ],
    ['', 'Could not change the worktree'],
  ])('%s', (code, message) => {
    expect(worktreeProblem(code)).toBe(message)
  })
})
