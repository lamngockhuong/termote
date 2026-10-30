import { useEffect, useId, useState } from 'react'
import {
  resetAllShortcuts,
  resetShortcut,
  setShortcut,
  useKeymap,
} from '../hooks/use-shortcuts'
import { tFor, useT } from '../i18n/i18n-context'
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

const en = tFor('en')

// Settings > Shortcuts (desktop): every command of the palette with its
// key, which the user can change, remove or reset, and whether it also runs
// while the terminal has focus. Kept on this device.
export function ShortcutsSection({ commands }: { commands: AppCommand[] }) {
  const { t } = useT()
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
    t((commands.find((c) => c.id === id) as AppCommand).title)

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
      const refused = chord && isRefusedChord(chord, apple)
      const why = !chord
        ? keyFromCode(e.code) || !plain
          ? t('settings.shortcuts.useMod', { mod: apple ? '⌘' : 'Ctrl' })
          : t('settings.shortcuts.unusable')
        : refused && t(refused)
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
  }, [recording, apple, t])

  const q = filter.trim().toLowerCase()
  const shown = commands.filter((c) => {
    if (!q) return true
    const key = keymap.byId[c.id]?.key
    return (
      // A command's English name finds it too
      t(c.title).toLowerCase().includes(q) ||
      en(c.title).toLowerCase().includes(q) ||
      (!!key && formatChord(key, apple).toLowerCase().includes(q))
    )
  })
  const categories = [...new Set(shown.map((c) => c.category))]
  const custom = Object.values(keymap.byId).some((k) => k?.custom)

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <p className="m-0 text-[12px] text-fg-muted">
        {t('settings.shortcuts.intro', { key: formatChord('Mod+W', apple) })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={filterId} className="sr-only">
          {t('settings.shortcuts.filter')}
        </label>
        <input
          id={filterId}
          type="search"
          value={filter}
          placeholder={t('settings.shortcuts.filterPlaceholder')}
          onChange={(e) => setFilter(e.target.value)}
          className="h-9 min-w-0 flex-1 rounded-control border border-border bg-bg px-2 text-[13px] text-fg"
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={!custom}
          onClick={() => setConfirmReset(true)}
        >
          {t('settings.shortcuts.resetAll')}
        </Button>
      </div>
      {!shown.length && (
        <p className="m-0 text-[13px] text-fg-muted">
          {t('settings.shortcuts.none')}
        </p>
      )}
      {categories.map((category) => (
        <section key={category} aria-label={t(category)}>
          <h4 className="m-0 mt-2 text-[12px] font-medium uppercase tracking-wide text-fg-muted">
            {t(category)}
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
        title={t('settings.shortcuts.resetAllTitle')}
        confirmLabel={t('settings.shortcuts.resetAllConfirm')}
        destructive
        onConfirm={() => {
          resetAllShortcuts()
          setConfirmReset(false)
        }}
        onCancel={() => setConfirmReset(false)}
      >
        {t('settings.shortcuts.resetAllBody')}
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
  const { t } = useT()
  const titleId = useId()
  const title = t(command.title)
  const key = resolved?.key
  const canTerminal = !!key && canRunInTerminal(key, apple)
  const notes = [
    ...conflicts.map((name) => t('settings.shortcuts.alsoUsedBy', { name })),
    replacedBy && t('settings.shortcuts.replacedBy', { name: replacedBy }),
    problem,
  ].filter(Boolean) as string[]
  const noteId = useId()
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border py-1.5 last:border-0">
      <span id={titleId} className="min-w-0 flex-1 basis-40 text-[14px]">
        {title}
      </span>
      <kbd
        className={`rounded-control border px-1.5 font-ui text-[12px] ${conflicts.length ? 'border-warning text-warning' : 'border-border text-fg-muted'}`}
      >
        {key ? formatChord(key, apple) : t('settings.shortcuts.noKey')}
      </kbd>
      <Button
        variant="secondary"
        size="sm"
        aria-describedby={notes.length ? noteId : undefined}
        aria-label={t('settings.shortcuts.changeName', { name: title })}
        onClick={onRecord}
      >
        {recording
          ? t('settings.shortcuts.pressKeys')
          : t('settings.shortcuts.change')}
      </Button>
      {key && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('settings.shortcuts.removeName', { name: title })}
          onClick={() => setShortcut(command.id, { key: null })}
        >
          {t('settings.shortcuts.remove')}
        </Button>
      )}
      {resolved?.custom && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('settings.shortcuts.resetName', { name: title })}
          onClick={() => resetShortcut(command.id)}
        >
          {t('settings.shortcuts.reset')}
        </Button>
      )}
      <span className="flex items-center gap-1 text-[12px] text-fg-muted">
        <Switch
          label={t('settings.shortcuts.inTerminalName', { name: title })}
          checked={!!resolved?.inTerminal}
          disabled={!canTerminal}
          onChange={(v) => setShortcut(command.id, { inTerminal: v })}
        />
        {key && !canTerminal
          ? t('settings.shortcuts.terminalUses')
          : t('settings.shortcuts.inTerminal')}
      </span>
      {recording && (
        <span aria-live="polite" className="sr-only">
          {t('settings.shortcuts.recording', { name: title })}
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
