import { File, Lock } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useAgentCommands } from '../hooks/use-agent-commands'
import {
  type FilesError,
  filesError,
  requestFilesFocus,
  useFiles,
} from '../hooks/use-files'
import {
  type FindResponse,
  findFiles,
  type PromptTemplate,
  RequestError,
} from '../hooks/use-mux-api'
import { usePromptTemplates } from '../hooks/use-prompt-templates'
import { useSettings } from '../hooks/use-settings'
import { useKeymap } from '../hooks/use-shortcuts'
import { useT } from '../i18n/i18n-context'
import type { Session, SessionGroup } from '../types/session'
import { paneCommand } from '../utils/agent-start'
import type { AppCommand, PaletteMode } from '../utils/app-commands'
import { requestDraftInsert } from '../utils/chat-draft'
import { splitPath } from '../utils/files-format'
import {
  parseLine,
  parsePrefix,
  prefixOf,
  rankByMatch,
} from '../utils/palette-match'
import { onPaneRemap } from '../utils/pane-remap'
import { isApplePlatform } from '../utils/platform'
import { firstLine } from '../utils/prompt-templates'
import {
  type CommandId,
  chordFromEvent,
  commandForChord,
  formatChord,
} from '../utils/shortcuts'
import {
  applyPick,
  BUILTIN_COMMANDS,
  CUSTOM_TRIGGER,
  commandDescription,
  mergeSlashCommands,
  type SlashCommand,
} from '../utils/slash-commands'
import { requestTemplateFill } from '../utils/template-fill-request'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { FIND_DEBOUNCE_MS, FIND_ERRORS } from './file-search'
import { Sheet } from './ui/sheet'

// "Searching…" shows once a search takes this long
export const SEARCHING_NOTICE_MS = 300

export interface CommandPaletteProps {
  mode: PaletteMode
  onClose: () => void
  // Closes the palette, then runs fn once it is gone, so the focus fn
  // moves is not taken back by the closing dialog
  onRun: (fn: () => void) => void
  commands: AppCommand[]
  // The tab on screen and its pane
  session: Session
  sessions: Session[]
  groups: SessionGroup[]
  readOnly: boolean
  // The Files panel can show this pane's files
  filesAvailable: boolean
  // Shows the Files panel when it is not
  showFilesPanel: () => void
  // The pane's agent has a Chat composer to type a command into
  composer: boolean
  // The server keeps prompt templates (caps.templates)
  templates?: boolean
  showChat: () => void
  // Types text into the terminal (no Enter) and focuses it
  sendToTerminal: (text: string) => void
  selectSession: (id: string) => void
  // Only where the client picks the pane (Herdr, Zellij)
  selectPane?: (paneId: string) => void
  // Mod+Enter on a tab or pane: it opens in a window of its own (desktop,
  // where a link names it)
  openInWindow?: (target: { tabId: string; paneId?: string }) => void
  // Why no tab or pane can be picked here (a focus window shows one target):
  // the `@` list stays, every row dimmed with this reason
  sessionsOff?: string
}

interface Item {
  key: string
  label: string
  description?: string
  // The group shown before the label (a command's category)
  group?: string
  // The key that runs it, as shown
  hint?: string
  sensitive?: boolean
  disabledReason?: string
  // Mod+Enter: a file opens in a pinned tab, a tab or pane in a new window
  run?: (pin: boolean) => void
}

type Found =
  | { paneId: string; q: string; res: FindResponse }
  | { paneId: string; q: string; error: FilesError }

const TITLES: Record<PaletteMode, string> = {
  files: 'Go to file',
  commands: 'Commands',
  line: 'Go to line',
  sessions: 'Go to tab or pane',
}

const MODE_OF: Partial<Record<CommandId, PaletteMode>> = {
  'palette.quickOpen': 'files',
  'palette.commands': 'commands',
  'palette.goToLine': 'line',
  'palette.sessions': 'sessions',
}

// A store is never read for a pane that is not there
const NO_PANE = '\u0000none'

// The command palette: one input whose first character picks what it
// lists (nothing: files of the pane, ">": commands, ":": a line of the open
// file, "@": tabs and panes), and the list it drives as a combobox.
export function CommandPalette({
  mode,
  onClose,
  onRun,
  commands,
  session,
  sessions,
  groups,
  readOnly,
  filesAvailable,
  showFilesPanel,
  composer,
  templates = false,
  showChat,
  sendToTerminal,
  selectSession,
  selectPane,
  openInWindow,
  sessionsOff,
}: CommandPaletteProps) {
  const apple = isApplePlatform()
  const keymap = useKeymap(commands)
  const [text, setText] = useState(() => prefixOf(mode))
  const { mode: current, query } = parsePrefix(text)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const noteId = useId()
  // Set before a command closes the palette: focus stays where it goes
  const keepFocus = useRef(false)
  const paneId = session.paneId ?? ''
  const f = useFiles(paneId || NO_PANE)
  const { settings } = useSettings()
  const { t } = useT()

  // Another pane on screen, or the pane's id moved: the palette closes
  const openedOn = useRef(paneId)
  useEffect(() => {
    if (paneId !== openedOn.current) onClose()
  }, [paneId, onClose])
  useEffect(
    () =>
      onPaneRemap((shift) => {
        const id = openedOn.current
        // A moved id is stale too
        if (shift.stale.has(id)) onClose()
      }),
    [onClose],
  )

  const run = (fn: () => void, keep = true) => {
    keepFocus.current = keep
    onRun(fn)
  }

  // Files

  const canFind = filesAvailable && !!paneId
  const ignored = f.isRepo && !readOnly && settings.findIncludeIgnored
  const excludes = settings.findExcludes
  const [found, setFound] = useState<Found | null>(null)
  // Bumped when the root moved under a search: it is sent again
  const [retry, setRetry] = useState(0)
  // Enter pressed before the query's results came: the first one opens
  // once they do, and the search goes now (searchNow)
  const [pending, setPending] = useState<{ q: string; pin: boolean }>()
  const [searchNow, setSearchNow] = useState(0)
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const rootRef = useRef(f.root)
  rootRef.current = f.root
  const { load, rootChanged } = f
  // biome-ignore lint/correctness/useExhaustiveDependencies: a moved root (retry) and an early Enter (searchNow) send it again
  useEffect(() => {
    if (current !== 'files' || !query || !canFind) return
    const abort = new AbortController()
    const timer = setTimeout(
      async () => {
        try {
          const res = await findFiles(
            { paneId, place: f.place },
            { q: query, root: rootRef.current, ignored, exclude: excludes },
            abort.signal,
          )
          setFound({ paneId, q: query, res })
        } catch (err) {
          // A newer search replaced this one
          if (abort.signal.aborted) return
          if (err instanceof RequestError && err.status === 409 && err.root) {
            rootChanged(err.root)
            setRetry((n) => n + 1)
            return
          }
          setFound({ paneId, q: query, error: filesError(err) })
        }
      },
      pendingRef.current?.q === query ? 0 : FIND_DEBOUNCE_MS,
    )
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [
    current,
    query,
    canFind,
    paneId,
    ignored,
    excludes,
    retry,
    searchNow,
    rootChanged,
  ])
  const fresh =
    found && found.paneId === paneId && found.q === query ? found : null

  // "Searching…" only once a search is slow to answer
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    setSlow(false)
    if (current !== 'files' || !query) return
    const timer = setTimeout(() => setSlow(true), SEARCHING_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [current, query])

  const openFile = (root: string, path: string, pin: boolean) =>
    run(() => {
      f.openFromFind(root, path, { pin })
      showFilesPanel()
      requestFilesFocus(paneId, 'file')
    })

  const fileItem = (root: string, path: string, sensitive = false): Item => {
    const [dir, name] = splitPath(path)
    return {
      key: `file:${root}\u0000${path}`,
      label: name,
      description: dir,
      sensitive,
      run: (pin) => openFile(root, path, pin),
    }
  }

  // Only once the pane's root is known: one opened under another root
  // would move the store back there
  const recent = f.recent.filter((r) => r.root === f.root)
  useEffect(() => {
    if (current === 'files' && canFind && rootRef.current === undefined) load()
  }, [current, canFind, load])

  let note: string | undefined
  let fileItems: Item[] = []
  if (current === 'files') {
    if (!canFind) {
      fileItems = [
        {
          key: 'files:none',
          label: 'Open a file',
          disabledReason: 'Not available for this pane',
        },
      ]
    } else if (!query) {
      // Files opened lately, but the one on screen, then the open tabs
      const shown = f.active?.path
      const listed = new Set<string>()
      for (const r of recent) {
        if (r.path === shown) continue
        listed.add(r.path)
        fileItems.push(fileItem(r.root, r.path))
      }
      for (const tab of f.tabs) {
        if (listed.has(tab.path) || tab.path === shown) continue
        const [dir, name] = splitPath(tab.path)
        fileItems.push({
          key: `tab:${tab.id}`,
          label: name,
          description: dir,
          run: () =>
            run(() => {
              f.activate(tab.id)
              showFilesPanel()
              requestFilesFocus(paneId, 'file')
            }),
        })
      }
      if (!fileItems.length) note = 'Type a file name'
    } else if (fresh && 'error' in fresh) {
      note = t(FIND_ERRORS[fresh.error])
    } else if (fresh) {
      const { root, results } = fresh.res
      const recentPaths = new Set(
        f.recent.filter((r) => r.root === root).map((r) => r.path),
      )
      // The server's order, files opened lately first
      const sorted = [
        ...results.filter((r) => recentPaths.has(r.path)),
        ...results.filter((r) => !recentPaths.has(r.path)),
      ]
      fileItems = sorted.map((r) => fileItem(root, r.path, r.sensitive))
      if (!fileItems.length) note = 'No files match'
    } else if (slow) note = 'Searching…'
  }

  // Waiting results arrived: the first one opens
  // biome-ignore lint/correctness/useExhaustiveDependencies: fileItems follows fresh
  useEffect(() => {
    if (!pending || pending.q !== query || !fresh) return
    setPending(undefined)
    fileItems[0]?.run?.(pending.pin)
  }, [pending, fresh, query])

  // Commands

  const agentName = (session.hasAgent && session.agentName) || ''
  const trigger = CUSTOM_TRIGGER[agentName] ?? '/'
  const custom = useAgentCommands(
    paneId,
    current === 'commands' && !!agentName && !!paneId,
  )
  const agentCommands = useMemo(
    () =>
      agentName
        ? mergeSlashCommands(
            BUILTIN_COMMANDS[agentName] ?? [],
            custom.map((c) => ({ ...c, trigger })),
          )
        : [],
    [agentName, custom, trigger],
  )
  const inTerminal = !readOnly && paneCommand(session) === agentName
  const agentReason = composer
    ? undefined
    : readOnly
      ? 'View only'
      : inTerminal
        ? undefined
        : "Open the agent's Chat to use its commands"

  const runAgentCommand = (c: SlashCommand) => {
    if (composer)
      run(() => {
        requestDraftInsert(paneId, c)
        showChat()
      })
    else {
      const at = { trigger: c.trigger ?? '/', query: '', start: 0, end: 0 }
      run(() => sendToTerminal(applyPick('', at, c).text))
    }
  }

  // Prompt templates, read again as the commands list opens: another
  // device may have changed them. They go into the Chat's draft, filled in.
  const prompts = usePromptTemplates()
  const listTemplates = templates && current === 'commands'
  const { refresh: refreshPrompts } = prompts
  useEffect(() => {
    if (listTemplates) void refreshPrompts()
  }, [listTemplates, refreshPrompts])
  const templateReason = readOnly
    ? 'View only'
    : composer
      ? undefined
      : "Open the agent's Chat to use templates"
  const runTemplate = (t: PromptTemplate) =>
    run(() => {
      showChat()
      requestTemplateFill({ paneId, templateId: t.id, agent: agentName })
    })

  const runCommand = (c: AppCommand) => {
    const next = MODE_OF[c.id]
    if (next) {
      setText(prefixOf(next))
      inputRef.current?.focus()
      return
    }
    run(c.run, !c.restoreFocus)
  }

  const commandItems = (): Item[] => {
    const items: Item[] = [
      ...commands.map((c) => {
        const key = keymap.byId[c.id]?.key
        return {
          key: c.id,
          label: c.title,
          group: c.category,
          hint: key && formatChord(key, apple),
          disabledReason: c.disabledReason,
          run: () => runCommand(c),
        }
      }),
      ...agentCommands.map((c) => ({
        key: `agent:${c.trigger ?? '/'}${c.name}`,
        label: `${c.trigger ?? '/'}${c.name}`,
        description: commandDescription(c, t),
        group: 'Agent',
        disabledReason: agentReason,
        run: () => runAgentCommand(c),
      })),
      ...(listTemplates ? prompts.templates : []).map((t) => ({
        key: `template:${t.id}`,
        label: visibleUnsafe(t.name),
        description: visibleUnsafe(firstLine(t.text)),
        group: 'Template',
        disabledReason: templateReason,
        run: () => runTemplate(t),
      })),
    ]
    return rankByMatch(items, query, (i) => `${i.group} ${i.label}`)
  }

  // A line of the open file

  const lineItems = (): Item[] => {
    const tab = canFind ? f.active : undefined
    if (!tab)
      return [
        {
          key: 'line:none',
          label: 'Go to line',
          disabledReason: 'Open a file first',
        },
      ]
    const at = parseLine(query)
    if (!at)
      return [
        {
          key: 'line:type',
          label: 'Go to line',
          description: tab.path,
          disabledReason: 'Type a line number, or line:column',
        },
      ]
    return [
      {
        key: 'line:go',
        label: at.col
          ? `Go to line ${at.line}, column ${at.col}`
          : `Go to line ${at.line}`,
        description: tab.path,
        run: () =>
          run(() => {
            f.open(tab.path, { line: at.line, col: at.col })
            showFilesPanel()
            requestFilesFocus(paneId, 'file')
          }),
      },
    ]
  }

  // Tabs of every group, and the panes of this tab where they can be picked

  const sessionItems = (): Item[] => {
    const groupName = new Map(groups.map((g) => [g.id, g.name]))
    const items: Item[] = sessions.map((s) => ({
      key: `tab:${s.id}`,
      label: `${s.icon} ${s.name}`,
      description:
        s.id === session.id
          ? 'Current tab'
          : s.groupId && groupName.get(s.groupId),
      // The terminal, focused before, shows the new tab
      run: (mod) =>
        mod && openInWindow
          ? run(() => openInWindow({ tabId: s.id }), false)
          : run(() => selectSession(s.id), false),
    }))
    if (selectPane)
      for (const p of session.panes ?? [])
        items.push({
          key: `pane:${p.id}`,
          label: p.label || p.command || p.id,
          description: p.id === session.paneId ? 'Current pane' : 'Pane',
          run: (mod) =>
            mod && openInWindow
              ? run(
                  () => openInWindow({ tabId: session.id, paneId: p.id }),
                  false,
                )
              : run(() => selectPane(p.id), false),
        })
    const shown = sessionsOff
      ? items.map((i) => ({ ...i, disabledReason: sessionsOff }))
      : items
    return rankByMatch(shown, query, (i) => `${i.label} ${i.description ?? ''}`)
  }

  const items =
    current === 'files'
      ? fileItems
      : current === 'commands'
        ? commandItems()
        : current === 'line'
          ? lineItems()
          : sessionItems()
  const at = Math.min(active, Math.max(items.length - 1, 0))

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query or list starts at the top
  useEffect(() => setActive(0), [text, items.length])

  // Keep the highlighted row in view
  useEffect(() => {
    document
      .getElementById(`${listId}-${at}`)
      ?.scrollIntoView?.({ block: 'nearest' })
  }, [listId, at])

  const choose = (i: number, pin: boolean) => {
    const item = items[i]
    if (!item || item.disabledReason || !item.run) return
    item.run(pin)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter or an arrow that ends an IME composition is the composition's
    if (e.nativeEvent.isComposing) return
    // The palette's own keys change the mode here, never the browser's
    // (Ctrl+P would print); its key again moves down the list
    const chord = chordFromEvent(e, apple)
    const id = chord && commandForChord(keymap, chord)
    const next = id ? MODE_OF[id] : undefined
    if (next) {
      e.preventDefault()
      if (next === current)
        setActive((i) => (i + 1) % Math.max(items.length, 1))
      else setText(prefixOf(next))
      return
    }
    const n = items.length
    const move = (to: number) => {
      e.preventDefault()
      if (n) setActive(((to % n) + n) % n)
    }
    switch (e.key) {
      case 'ArrowDown':
        return move(at + 1)
      case 'ArrowUp':
        return move(at - 1)
      case 'PageDown':
        return move(Math.min(at + 10, n - 1))
      case 'PageUp':
        return move(Math.max(at - 10, 0))
      case 'Enter': {
        e.preventDefault()
        const pin = apple ? e.metaKey : e.ctrlKey
        // The results of what is typed are not in yet
        if (current === 'files' && query && canFind && !fresh) {
          setPending({ q: query, pin })
          setSearchNow((n) => n + 1)
          return
        }
        choose(at, pin)
      }
    }
  }

  const option = (i: number) => `${listId}-${i}`
  const count = items.filter((i) => !i.disabledReason).length

  let body: ReactNode = null
  if (items.length)
    body = (
      <div
        id={listId}
        role="listbox"
        aria-label={TITLES[current]}
        className="max-h-[50vh] overflow-y-auto py-1"
      >
        {items.map((item, i) => {
          const reasonId = item.disabledReason ? `${option(i)}-why` : undefined
          return (
            <div
              key={item.key}
              id={option(i)}
              role="option"
              tabIndex={-1}
              aria-selected={i === at}
              aria-disabled={item.disabledReason ? true : undefined}
              aria-describedby={reasonId}
              // Focus stays in the input, which points here
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => i !== at && setActive(i)}
              onClick={(e) => choose(i, apple ? e.metaKey : e.ctrlKey)}
              className={`flex min-h-10 cursor-pointer items-center gap-2 px-3 py-1 text-[13px] ${i === at ? 'bg-accent-soft' : ''} ${item.disabledReason ? 'cursor-default opacity-60' : ''}`}
            >
              {current === 'files' && (
                <File
                  size={15}
                  aria-hidden="true"
                  className="shrink-0 text-fg-muted"
                />
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-fg">
                  {item.group && (
                    <span className="text-fg-muted">{item.group}: </span>
                  )}
                  {visibleUnsafe(item.label)}
                </span>
                {item.description && (
                  <span className="truncate text-[12px] text-fg-subtle">
                    {visibleUnsafe(item.description)}
                  </span>
                )}
                {reasonId && (
                  <span id={reasonId} className="text-[12px] text-fg-muted">
                    {item.disabledReason}
                  </span>
                )}
              </span>
              {item.sensitive && (
                <span
                  className="flex shrink-0 items-center text-warning"
                  title="May contain secrets"
                >
                  <Lock size={12} aria-hidden="true" />
                  <span className="sr-only">Sensitive</span>
                </span>
              )}
              {item.hint && (
                <kbd className="shrink-0 rounded-control border border-border px-1.5 font-ui text-[11px] text-fg-muted">
                  {item.hint}
                </kbd>
              )}
            </div>
          )
        })}
      </div>
    )

  return (
    <Sheet
      isOpen
      onClose={onClose}
      title={TITLES[current]}
      closeLabel="Close command palette"
      className="mt-[12vh]! mb-auto! max-w-xl!"
      focusOnOpen={() => inputRef.current?.focus()}
      keepFocus={keepFocus}
    >
      <div className="border-b border-border p-2">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Search files, commands, lines, tabs"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length ? option(at) : undefined}
          aria-describedby={note ? noteId : undefined}
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // An Enter waiting for results was for what was typed before
            setPending(undefined)
          }}
          onKeyDown={onKeyDown}
          placeholder="File name, > command, : line, @ tab"
          className="w-full rounded-control border border-border bg-bg px-2 py-1.5 text-[14px] text-fg outline-none focus-visible:border-accent"
        />
      </div>
      {note && (
        <p id={noteId} className="px-3 py-2 text-[13px] text-fg-muted">
          {note}
        </p>
      )}
      {body}
      <p aria-live="polite" className="sr-only">
        {count === 1 ? '1 result' : `${count} results`}
      </p>
    </Sheet>
  )
}

export default CommandPalette
