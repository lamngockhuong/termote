import { useEffect, useId, useState } from 'react'
import {
  resetAllShortcuts,
  resetShortcut,
  setShortcut,
  useKeymap,
} from '../hooks/use-shortcuts'
import type { AppCommand } from '../utils/app-commands'
import { isApplePlatform } from '../utils/platform'
import {
  type CommandId,
  canRunInTerminal,
  chordFromEvent,
  findConflicts,
  formatChord,
  isRefusedChord,
  keyFromCode,
} from '../utils/shortcuts'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Switch } from './ui/switch'

const MODIFIER_CODE = /^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/

// Settings > Shortcuts (desktop): every command of the palette with its
// key, which the user can change, remove or reset, and whether it also runs
// while the terminal has focus. Kept on this device.
export function ShortcutsSection({ commands }: { commands: AppCommand[] }) {
  const apple = isApplePlatform()
  const keymap = useKeymap(commands)
  const conflicts = findConflicts(keymap)
  const [filter, setFilter] = useState('')
  const [recording, setRecording] = useState<CommandId | null>(null)
  const [problem, setProblem] = useState<{ id: CommandId; text: string }>()
  const [confirmReset, setConfirmReset] = useState(false)
  const filterId = useId()
  // Every id of the keymap is one of commands
  const titleOf = (id: CommandId) =>
    (commands.find((c) => c.id === id) as AppCommand).title

  // The next key pressed is the command's key; Escape gives up. Taken
  // before anything else sees it (capture), so no shortcut runs meanwhile.
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (MODIFIER_CODE.test(e.code)) return
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      if (e.key === 'Escape' && plain) {
        setProblem(undefined)
        setRecording(null)
        return
      }
      const chord = chordFromEvent(e, apple)
      const why = !chord
        ? keyFromCode(e.code) || !plain
          ? `Use ${apple ? '⌘' : 'Ctrl'} with a key`
          : 'This key cannot be used'
        : isRefusedChord(chord, apple)
      if (!chord || why) {
        setProblem({ id: recording, text: why as string })
        return
      }
      setShortcut(recording, { key: chord })
      setProblem(undefined)
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, apple])

  const q = filter.trim().toLowerCase()
  const shown = commands.filter((c) => {
    if (!q) return true
    const key = keymap.byId[c.id]?.key
    return (
      c.title.toLowerCase().includes(q) ||
      (!!key && formatChord(key, apple).toLowerCase().includes(q))
    )
  })
  const categories = [...new Set(shown.map((c) => c.category))]
  const custom = Object.values(keymap.byId).some((k) => k?.custom)

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <p className="m-0 text-[12px] text-fg-muted">
        Kept on this device. A key the browser handles first (such as{' '}
        {formatChord('Mod+W', apple)}) never reaches the app.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={filterId} className="sr-only">
          Filter shortcuts
        </label>
        <input
          id={filterId}
          type="search"
          value={filter}
          placeholder="Filter by name or key"
          onChange={(e) => setFilter(e.target.value)}
          className="h-9 min-w-0 flex-1 rounded-control border border-border bg-bg px-2 text-[13px] text-fg"
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={!custom}
          onClick={() => setConfirmReset(true)}
        >
          Reset all shortcuts
        </Button>
      </div>
      {!shown.length && (
        <p className="m-0 text-[13px] text-fg-muted">No shortcut matches</p>
      )}
      {categories.map((category) => (
        <section key={category} aria-label={category}>
          <h4 className="m-0 mt-2 text-[12px] font-medium uppercase tracking-wide text-fg-muted">
            {category}
          </h4>
          <ul className="m-0 flex list-none flex-col p-0">
            {shown
              .filter((c) => c.category === category)
              .map((c) => (
                <ShortcutRow
                  key={c.id}
                  command={c}
                  apple={apple}
                  resolved={keymap.byId[c.id]}
                  recording={recording === c.id}
                  problem={problem?.id === c.id ? problem.text : undefined}
                  conflicts={(conflicts.get(c.id) ?? []).map(titleOf)}
                  replacedBy={
                    keymap.byId[c.id]?.replacedBy &&
                    titleOf(keymap.byId[c.id]?.replacedBy as CommandId)
                  }
                  onRecord={() => {
                    setProblem(undefined)
                    setRecording(recording === c.id ? null : c.id)
                  }}
                />
              ))}
          </ul>
        </section>
      ))}
      <ConfirmDialog
        isOpen={confirmReset}
        title="Reset all shortcuts?"
        confirmLabel="Reset all"
        destructive
        onConfirm={() => {
          resetAllShortcuts()
          setConfirmReset(false)
        }}
        onCancel={() => setConfirmReset(false)}
      >
        Every command gets its default key back.
      </ConfirmDialog>
    </div>
  )
}

function ShortcutRow({
  command,
  apple,
  resolved,
  recording,
  problem,
  conflicts,
  replacedBy,
  onRecord,
}: {
  command: AppCommand
  apple: boolean
  resolved?: { key?: string; inTerminal: boolean; custom: boolean }
  recording: boolean
  problem?: string
  conflicts: string[]
  replacedBy?: string
  onRecord: () => void
}) {
  const titleId = useId()
  const key = resolved?.key
  const canTerminal = !!key && canRunInTerminal(key, apple)
  const notes = [
    ...conflicts.map((t) => `Also used by ${t}`),
    replacedBy && `Replaced by your shortcut for ${replacedBy}`,
    problem,
  ].filter(Boolean) as string[]
  const noteId = useId()
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border py-1.5 last:border-0">
      <span id={titleId} className="min-w-0 flex-1 basis-40 text-[14px]">
        {command.title}
      </span>
      <kbd
        className={`rounded-control border px-1.5 font-ui text-[12px] ${conflicts.length ? 'border-warning text-warning' : 'border-border text-fg-muted'}`}
      >
        {key ? formatChord(key, apple) : 'No key'}
      </kbd>
      <Button
        variant="secondary"
        size="sm"
        aria-describedby={notes.length ? noteId : undefined}
        aria-label={`Change the key of ${command.title}`}
        onClick={onRecord}
      >
        {recording ? 'Press keys…' : 'Change'}
      </Button>
      {key && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove the key of ${command.title}`}
          onClick={() => setShortcut(command.id, { key: null })}
        >
          Remove
        </Button>
      )}
      {resolved?.custom && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Reset the key of ${command.title}`}
          onClick={() => resetShortcut(command.id)}
        >
          Reset
        </Button>
      )}
      <span className="flex items-center gap-1 text-[12px] text-fg-muted">
        <Switch
          label={`${command.title}: also in the terminal`}
          checked={!!resolved?.inTerminal}
          disabled={!canTerminal}
          onChange={(v) => setShortcut(command.id, { inTerminal: v })}
        />
        {key && !canTerminal
          ? 'The terminal uses this key'
          : 'Also in the terminal'}
      </span>
      {recording && (
        <span aria-live="polite" className="sr-only">
          Press the new key for {command.title}, or Escape
        </span>
      )}
      {notes.length > 0 && (
        <span
          id={noteId}
          className="basis-full text-[12px] text-warning"
          role={problem ? 'alert' : undefined}
        >
          {notes.join('. ')}
        </span>
      )}
    </li>
  )
}
