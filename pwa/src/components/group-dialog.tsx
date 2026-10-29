import { X } from 'lucide-react'
import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import {
  listRecentGroups,
  type RecentGroup,
  RequestError,
  removeRecentGroup,
} from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button, IconButton } from './ui/button'
import { Sheet } from './ui/sheet'

const INPUT_CLASSES =
  'h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch'

// The server takes a name of at most 64 bytes
export const MAX_GROUP_NAME_BYTES = 64

export const nameTooLong = (name: string) =>
  new TextEncoder().encode(name).length > MAX_GROUP_NAME_BYTES

// The recent groups shown before "Show more"
export const RECENT_SHOWN = 5

// name, or the first of name-2, name-3, ... no open group uses: a recent
// group's name is often still taken. Empty when none fits in
// MAX_GROUP_NAME_BYTES.
export function freeGroupName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name
  for (let n = 2; ; n++) {
    const next = `${name}-${n}`
    if (nameTooLong(next)) return ''
    if (!taken.includes(next)) return next
  }
}

// What a group is on each backend: a Herdr workspace, a tmux or a Zellij
// session
export type GroupKind = 'workspace' | 'tmux' | 'zellij'

const GROUP_NOUN: Record<GroupKind, MessageKey> = {
  workspace: 'shell.group.workspace',
  tmux: 'shell.group.tmux',
  zellij: 'shell.group.zellij',
}

// What a group is called, in the app's language ("tmux session")
export const groupNoun = (kind: GroupKind, t: Translate<MessageKey>) =>
  t(GROUP_NOUN[kind])

// Why a name was refused: tmux reads some characters in a target
export const invalidNameMessage = (
  kind: GroupKind,
  t: Translate<MessageKey>,
) =>
  kind === 'tmux'
    ? t('shell.group.invalidNameTmux')
    : t('shell.group.invalidName')

// Why the server would not create the group, by its code
export function groupProblem(
  code: string,
  kind: GroupKind,
  t: Translate<MessageKey>,
): string {
  const noun = groupNoun(kind, t)
  const messages: Record<string, string> = {
    invalid_name: invalidNameMessage(kind, t),
    invalid_cwd: t('shell.group.invalidCwd'),
    not_found: t('shell.group.notFound'),
    not_directory: t('shell.group.notDirectory'),
    not_allowed: t('shell.group.notAllowed', { noun }),
    busy: t('shell.group.busy'),
    exists: t('shell.group.exists', { noun }),
    unsupported: t('shell.group.unsupported', { noun }),
  }
  return messages[code] ?? t('shell.group.createFailed', { noun })
}

interface Props {
  kind: GroupKind
  onClose: () => void
  // Creates the group; a refusal throws RequestError with the server's code.
  // isOpen tells whether the box is still open once the reply is in: after
  // a Cancel the group is made but nothing switches to it
  onCreate: (name: string, cwd: string, isOpen: () => boolean) => Promise<void>
  // The server keeps the groups created last (caps.recentGroups, a full
  // client): they are listed above the fields, to fill them in
  recent?: boolean
  // The names of the open groups, which a recent one's is changed from
  takenNames?: readonly string[]
}

// Asks for the name and directory of a new group and creates it. A refusal
// is shown under the fields, which keep what was typed.
export function GroupDialog({
  kind,
  onClose,
  onCreate,
  recent = false,
  takenNames = [],
}: Props) {
  const { t } = useT()
  const noun = groupNoun(kind, t)
  const [name, setName] = useState('')
  const [cwd, setCwd] = useState('')
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const nameId = useId()
  const cwdId = useId()
  const errorId = useId()
  const nameInput = useRef<HTMLInputElement>(null)
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

  // The recent groups as loaded: undefined while loading, null when they
  // could not be. hidden: removed here, put back where they were when the
  // server refuses.
  const [loaded, setLoaded] = useState<
    { groups: RecentGroup[]; readOnly: boolean } | null | undefined
  >()
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [expanded, setExpanded] = useState(false)
  const [removeFailed, setRemoveFailed] = useState(false)
  const recentId = useId()
  useEffect(() => {
    if (!recent) return
    listRecentGroups().then(
      (r) => {
        if (!closed.current) setLoaded(r)
      },
      () => {
        if (!closed.current) setLoaded(null)
      },
    )
  }, [recent])
  const recentGroups = loaded?.groups.filter((g) => !hidden.has(g.id)) ?? []
  const shownGroups = expanded
    ? recentGroups
    : recentGroups.slice(0, RECENT_SHOWN)

  const pickRecent = (g: RecentGroup) => {
    setName(freeGroupName(g.name, takenNames))
    setCwd(g.cwd)
    setProblem(undefined)
    nameInput.current?.focus()
  }

  const removeRecent = async (id: string) => {
    setHidden((h) => new Set(h).add(id))
    setRemoveFailed(false)
    try {
      await removeRecentGroup(id)
    } catch (err) {
      // Removed on another device already: as good as done
      if (err instanceof RequestError && err.code === 'unknown_recent') return
      if (closed.current) return
      setHidden((h) => {
        const next = new Set(h)
        next.delete(id)
        return next
      })
      setRemoveFailed(true)
    }
  }

  // After the sheet focuses itself on open
  useEffect(() => {
    const id = requestAnimationFrame(() => nameInput.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (sending) return
    const trimmed = name.trim()
    if (!trimmed) {
      setProblem(t('shell.group.enterName'))
      return
    }
    if (nameTooLong(trimmed)) {
      setProblem(t('shell.group.tooLong', { n: MAX_GROUP_NAME_BYTES }))
      return
    }
    setSending(true)
    setProblem(undefined)
    try {
      await onCreate(trimmed, cwd.trim(), () => !closed.current)
      if (!closed.current) onClose()
    } catch (err) {
      if (closed.current) return
      setProblem(
        err instanceof RequestError
          ? groupProblem(err.code, kind, t)
          : // Lost on the way back, perhaps after the group was made
            t('shell.group.maybeCreated', { noun }),
      )
    } finally {
      if (!closed.current) setSending(false)
    }
  }

  const describedBy = problem ? errorId : undefined
  return (
    <Sheet isOpen onClose={close} title={t('shell.group.new', { noun })}>
      <form onSubmit={submit} className="flex flex-col gap-3 p-4">
        {recent && loaded === undefined && (
          // One row held while loading: a short list arriving late moves
          // the fields less (a longer one still pushes them down)
          <div
            data-testid="recent-groups-loading"
            aria-hidden="true"
            className="h-9 pointer-coarse:h-touch"
          />
        )}
        {recentGroups.length > 0 && (
          <section aria-labelledby={recentId} className="flex flex-col gap-1">
            <h3 id={recentId} className="text-sm text-fg-muted">
              {t('shell.group.recent')}
            </h3>
            <ul
              className={
                expanded ? 'max-h-48 overflow-y-auto overscroll-contain' : ''
              }
            >
              {shownGroups.map((g) => {
                const name = visibleUnsafe(g.name)
                const cwd = visibleUnsafe(g.cwd)
                return (
                  <li key={g.id} className="flex min-w-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => pickRecent(g)}
                      aria-label={t('shell.group.useRecent', { name, cwd })}
                      className="flex min-h-9 min-w-0 flex-1 items-baseline gap-2 rounded-control px-2 py-1 text-left hover:bg-surface pointer-coarse:min-h-touch"
                    >
                      <span className="max-w-[40%] shrink-0 truncate text-sm font-medium text-fg">
                        {name}
                      </span>
                      <span
                        title={cwd}
                        className="min-w-0 truncate font-term text-xs text-fg-muted"
                      >
                        {cwd}
                      </span>
                    </button>
                    {!loaded?.readOnly && (
                      <IconButton
                        size="sm"
                        onClick={() => removeRecent(g.id)}
                        aria-label={t('shell.group.removeRecent', { name })}
                      >
                        <X size={15} aria-hidden="true" />
                      </IconButton>
                    )}
                  </li>
                )
              })}
            </ul>
            {!expanded && recentGroups.length > RECENT_SHOWN && (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="self-start rounded-control px-2 py-1 text-sm text-accent hover:bg-surface pointer-coarse:min-h-touch"
              >
                {t('shell.group.recentMore', {
                  n: recentGroups.length - RECENT_SHOWN,
                })}
              </button>
            )}
          </section>
        )}
        {removeFailed && (
          <div role="status" className="text-sm text-danger">
            {t('shell.group.recentRemoveFailed')}
          </div>
        )}
        <label htmlFor={nameId} className="text-sm text-fg-muted">
          {t('shell.group.name')}
        </label>
        <input
          ref={nameInput}
          id={nameId}
          type="text"
          value={name}
          autoComplete="off"
          enterKeyHint="next"
          aria-invalid={problem ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => {
            setName(e.target.value)
            setProblem(undefined)
          }}
          className={INPUT_CLASSES}
        />
        <label htmlFor={cwdId} className="text-sm text-fg-muted">
          {t('shell.group.directory')}
        </label>
        <input
          id={cwdId}
          type="text"
          value={cwd}
          placeholder={t('shell.group.home')}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          enterKeyHint="done"
          aria-describedby={describedBy}
          onChange={(e) => {
            setCwd(e.target.value)
            setProblem(undefined)
          }}
          className={`${INPUT_CLASSES} font-term`}
        />
        {problem && (
          <div id={errorId} role="alert" className="text-sm text-danger">
            {problem}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={sending}>
            {t('shell.group.create')}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
