import { ChevronDown, GitBranch } from 'lucide-react'
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import {
  listWorktrees,
  RequestError,
  type Worktree,
  type WorktreeList,
} from '../hooks/use-mux-api'
import { validBranchName } from '../utils/git-ref'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { MAX_GROUP_NAME_BYTES, nameTooLong } from './group-dialog'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Sheet } from './ui/sheet'

const INPUT_CLASSES =
  'h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch'

// Past this many branches the base list gets a filter field
const FILTER_FROM = 15

const EXISTING_NOTE = 'Checks out the existing branch; base is not used'

// What a worktree route's refusal means, by its code
export function worktreeProblem(code: string): string {
  const messages: Record<string, string> = {
    invalid_name: 'Not a valid branch name',
    branch_exists:
      'This branch exists; it is checked out as it is, without a base',
    create_failed:
      'Git refused: the branch may be checked out elsewhere, or the folder exists',
    open_failed:
      'The checkout was made but could not be opened; use Open worktree',
    not_git: 'This workspace is not in a git repository',
    linked_source: "Open it from the repository's own workspace",
    not_linked: 'Herdr does not manage this worktree',
    changed: 'This worktree changed; look again',
    ambiguous: 'More than one worktree uses this branch; open it in Herdr',
    not_found: 'It no longer exists; the list was refreshed',
    unknown_group: 'It no longer exists; the list was refreshed',
    busy: 'Another worktree change is still running; try again',
    unknown: 'Herdr is still working on it; check the list in a moment',
    unsupported: 'This Herdr cannot manage worktrees (needs 0.9.2 or later)',
  }
  return messages[code] ?? 'Could not change the worktree'
}

const problemOf = (err: unknown) =>
  worktreeProblem(err instanceof RequestError ? err.code : '')

// The last component of a checkout's path, for a short label
const lastPart = (path: string) =>
  path
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .pop() || path

// Reads a workspace's worktrees once, on open.
function useWorktreeList(
  groupId: string,
  load: (groupId: string) => Promise<WorktreeList>,
) {
  const [list, setList] = useState<WorktreeList>()
  const [problem, setProblem] = useState<string>()
  useEffect(() => {
    let live = true
    load(groupId).then(
      (l) => live && setList(l),
      (err) => live && setProblem(problemOf(err)),
    )
    return () => {
      live = false
    }
  }, [groupId, load])
  return { list, problem }
}

interface Props {
  mode: 'new' | 'open'
  // The workspace whose repository is used
  groupId: string
  onClose: () => void
  // Each throws RequestError with the server's code on a refusal. isOpen
  // tells whether the box is still open once the reply is in: after a
  // Cancel nothing switches to what was made
  onCreate: (
    w: { groupId: string; branch: string; base: string; label: string },
    isOpen: () => boolean,
  ) => Promise<void>
  onOpen: (branch: string, isOpen: () => boolean) => Promise<void>
  // Shows a worktree that already has a workspace
  onShow: (groupId: string) => void
  load?: (groupId: string) => Promise<WorktreeList>
}

// New worktree (a branch, its base, a label) and Open worktree (a linked
// worktree of the repository) in one sheet. A refusal is shown under the
// fields, which keep what was typed.
export function WorktreeDialog({
  mode: initialMode,
  groupId,
  onClose,
  onCreate,
  onOpen,
  onShow,
  load = listWorktrees,
}: Props) {
  const [mode, setMode] = useState(initialMode)
  const { list, problem: listProblem } = useWorktreeList(groupId, load)
  const [branch, setBranch] = useState('')
  const [base, setBase] = useState('')
  const [label, setLabel] = useState('')
  const [filter, setFilter] = useState('')
  // The base list is shown in the box, not as a popover the box would clip
  const [pickBase, setPickBase] = useState(false)
  const baseListId = useId()
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string>()
  // The server said the branch exists: its base was reset
  const [baseReset, setBaseReset] = useState(false)
  // Offered after create_failed when the branch already has a worktree
  const [openInstead, setOpenInstead] = useState<Worktree>()
  const branchId = useId()
  const labelId = useId()
  const errorId = useId()
  const branchInput = useRef<HTMLInputElement>(null)
  // The user closed the box: a reply arriving later shows nothing
  const closed = useRef(false)
  useEffect(() => {
    closed.current = false
    return () => {
      closed.current = true
    }
  }, [])
  const close = () => {
    closed.current = true
    onClose()
  }

  // After the sheet focuses itself on open
  useEffect(() => {
    if (mode !== 'new') return
    const id = requestAnimationFrame(() => branchInput.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [mode])

  const branches = list?.branches ?? []
  const trimmed = branch.trim()
  const existing = baseReset || branches.includes(trimmed)
  const openable = (list?.worktrees ?? []).filter((w) => w.openable)

  // Runs one request; a refusal stays in the box unless it was closed
  const run = async (send: () => Promise<void>, onRefusal?: () => void) => {
    setSending(true)
    setProblem(undefined)
    try {
      await send()
      if (!closed.current) onClose()
    } catch (err) {
      if (closed.current) return
      setProblem(problemOf(err))
      onRefusal?.()
      if (err instanceof RequestError && err.code === 'branch_exists') {
        setBase('')
        setBaseReset(true)
      }
      if (err instanceof RequestError && err.code === 'create_failed') {
        setOpenInstead(openable.find((w) => w.branch === trimmed))
      }
    } finally {
      if (!closed.current) setSending(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (sending) return
    if (!validBranchName(trimmed)) {
      setProblem(trimmed ? worktreeProblem('invalid_name') : 'Enter a branch')
      return
    }
    if (nameTooLong(label.trim())) {
      setProblem(`Use at most ${MAX_GROUP_NAME_BYTES} bytes for the label`)
      return
    }
    // The server's label rule (validateTmuxTarget)
    if (/\p{Cc}/u.test(label) || label.trim().endsWith(';')) {
      setProblem("This workspace name can't be used")
      return
    }
    run(() =>
      onCreate(
        {
          groupId,
          branch: trimmed,
          base: existing ? '' : base,
          label: label.trim(),
        },
        () => !closed.current,
      ),
    )
  }

  const open = (w: Worktree) => {
    if (!w.branch) return
    if (w.groupId) {
      onShow(w.groupId)
      close()
      return
    }
    const name = w.branch
    run(() => onOpen(name, () => !closed.current))
  }

  const describedBy = problem ? errorId : undefined
  const problemLine = problem && (
    <div id={errorId} role="alert" className="text-sm text-danger">
      {problem}
    </div>
  )
  const shown = filter
    ? branches.filter((b) => b.toLowerCase().includes(filter.toLowerCase()))
    : branches

  if (mode === 'open') {
    return (
      <Sheet isOpen onClose={close} title="Open worktree">
        <div className="flex flex-col gap-3 p-4">
          {!list && !listProblem && (
            <p className="m-0 text-sm text-fg-muted">Reading the worktrees…</p>
          )}
          {listProblem && (
            <p role="alert" className="m-0 text-sm text-danger">
              {listProblem}
            </p>
          )}
          {list && openable.length === 0 && (
            <p className="m-0 text-sm text-fg-muted">
              No other worktrees. Create one with New worktree
            </p>
          )}
          {openable.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {openable.map((w) => (
                <li key={w.path}>
                  <Button
                    size="grow"
                    variant="secondary"
                    disabled={sending}
                    onClick={() => open(w)}
                    className="w-full justify-start text-left"
                  >
                    <GitBranch size={14} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">
                      {visibleUnsafe(w.branch ?? '')}
                      <span className="ml-2 text-fg-subtle">
                        {visibleUnsafe(lastPart(w.path))}
                      </span>
                    </span>
                    {w.groupId && (
                      <span className="text-[12px] text-fg-subtle">open</span>
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {problemLine}
          <div className="flex justify-end">
            <Button onClick={close}>Cancel</Button>
          </div>
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet isOpen onClose={close} title="New worktree">
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        <label htmlFor={branchId} className="text-sm text-fg-muted">
          Branch (new, or one to check out)
        </label>
        <input
          ref={branchInput}
          id={branchId}
          type="text"
          value={branch}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          enterKeyHint="next"
          aria-invalid={problem ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => {
            setBranch(e.target.value)
            setProblem(undefined)
            setBaseReset(false)
            setOpenInstead(undefined)
          }}
          className={`${INPUT_CLASSES} font-term`}
        />
        <span className="text-sm text-fg-muted">Base</span>
        {existing ? (
          <p className="m-0 text-sm text-fg-subtle">{EXISTING_NOTE}</p>
        ) : (
          <>
            <Button
              aria-label={`Base: ${base || 'Current HEAD'}`}
              aria-expanded={pickBase}
              aria-controls={baseListId}
              onClick={() => setPickBase(!pickBase)}
              className="self-start"
            >
              <GitBranch size={14} aria-hidden="true" />
              <span className="max-w-56 truncate">
                {base ? visibleUnsafe(base) : 'Current HEAD'}
              </span>
              <ChevronDown size={14} aria-hidden="true" />
            </Button>
            {pickBase && (
              <fieldset
                id={baseListId}
                className="m-0 flex min-w-0 flex-col gap-1 rounded-control border border-border p-1"
              >
                <legend className="sr-only">Base</legend>
                {branches.length > FILTER_FROM && (
                  <input
                    type="search"
                    value={filter}
                    placeholder="Filter branches"
                    aria-label="Filter branches"
                    spellCheck={false}
                    autoCapitalize="off"
                    onChange={(e) => setFilter(e.target.value)}
                    className={INPUT_CLASSES}
                  />
                )}
                <div className="max-h-48 overflow-y-auto">
                  {['', ...shown].map((b) => (
                    <label
                      key={b || ' HEAD'}
                      className="flex h-9 items-center gap-2 rounded-control px-2 text-sm text-fg hover:bg-surface pointer-coarse:h-touch"
                    >
                      <input
                        type="radio"
                        name={baseListId}
                        checked={base === b}
                        onChange={() => setBase(b)}
                        className="accent-accent"
                      />
                      <span className="min-w-0 truncate">
                        {b ? visibleUnsafe(b) : 'Current HEAD'}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
          </>
        )}
        <label htmlFor={labelId} className="text-sm text-fg-muted">
          Workspace name (optional)
        </label>
        <input
          id={labelId}
          type="text"
          value={label}
          autoComplete="off"
          enterKeyHint="done"
          aria-describedby={describedBy}
          onChange={(e) => {
            setLabel(e.target.value)
            setProblem(undefined)
          }}
          className={INPUT_CLASSES}
        />
        {listProblem && (
          <p className="m-0 text-sm text-fg-subtle">{listProblem}</p>
        )}
        {problemLine}
        {openInstead && (
          <Button
            disabled={sending}
            onClick={() => {
              setMode('open')
              setProblem(undefined)
              open(openInstead)
            }}
            className="self-start"
          >
            Open it
          </Button>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={sending}>
            Create
          </Button>
        </div>
      </form>
    </Sheet>
  )
}

interface RemoveProps {
  groupId: string
  // Set for the second confirmation (the worktree has changes): the checkout
  // the first one named
  force?: { path: string; branch: string }
  onConfirm: (w: { force: boolean; path: string; branch: string }) => void
  onCancel: () => void
  // What runs in the workspace, as the last snapshot named it
  children?: ReactNode
  load?: (groupId: string) => Promise<WorktreeList>
}

// Asks before removing a worktree workspace, naming the checkout Herdr
// reports for it (with unsafe characters shown), which the request then
// carries: the server removes nothing else. With force, asks the second time.
export function WorktreeRemoveDialog({
  groupId,
  force,
  onConfirm,
  onCancel,
  children,
  load = listWorktrees,
}: RemoveProps) {
  if (force) {
    return (
      <ConfirmDialog
        isOpen
        title={`Remove worktree "${visibleUnsafe(force.branch)}" anyway?`}
        confirmLabel="Remove anyway"
        destructive
        onConfirm={() => onConfirm({ force: true, ...force })}
        onCancel={onCancel}
      >
        <p className="m-0">
          This worktree has uncommitted or untracked changes. Remove it anyway?
          They are lost, and its terminals are ended first.
        </p>
      </ConfirmDialog>
    )
  }
  return (
    <RemoveConfirm
      groupId={groupId}
      onConfirm={onConfirm}
      onCancel={onCancel}
      load={load}
    >
      {children}
    </RemoveConfirm>
  )
}

function RemoveConfirm({
  groupId,
  onConfirm,
  onCancel,
  children,
  load = listWorktrees,
}: Omit<RemoveProps, 'force'>) {
  const { list, problem } = useWorktreeList(groupId, load)
  const entry = list?.worktrees.find((w) => w.groupId === groupId && w.linked)
  if (!entry) {
    return (
      <Sheet isOpen onClose={onCancel} title="Remove worktree">
        <div className="flex flex-col gap-4 p-4">
          <p
            role={problem || list ? 'alert' : undefined}
            className="m-0 text-sm text-fg-muted"
          >
            {problem ??
              (list ? worktreeProblem('not_linked') : 'Reading the worktree…')}
          </p>
          <div className="flex justify-end">
            <Button onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      </Sheet>
    )
  }
  const branch = entry.branch ?? ''
  return (
    <ConfirmDialog
      isOpen
      title={`Remove worktree "${visibleUnsafe(branch || lastPart(entry.path))}"?`}
      confirmLabel="Remove worktree"
      destructive
      onConfirm={() => onConfirm({ force: false, path: entry.path, branch })}
      onCancel={onCancel}
    >
      {branch && (
        <p className="m-0 mb-2">
          Branch{' '}
          <span className="break-all font-term text-fg">
            {visibleUnsafe(branch)}
          </span>
        </p>
      )}
      <p className="m-0">
        Deletes{' '}
        <span className="break-all font-term text-fg">
          {visibleUnsafe(entry.path)}
        </span>{' '}
        and closes this workspace. Files ignored by git (.env, node_modules) are
        deleted too. The branch is kept.
      </p>
      {children}
    </ConfirmDialog>
  )
}
