import { Trash2, X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import {
  EDITOR_FONT_SIZES,
  EDITOR_TAB_SIZES,
  type EditorTabSize,
  FIND_EXCLUDES_DEFAULT,
  FIND_EXCLUDES_MAX,
  findExcludeProblem,
  type ImeSendBehavior,
  type PasteSource,
  type Settings,
  TASK_HISTORY_LINE_CHOICES,
} from '../hooks/use-settings'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { UI_STYLES, type UiStyle } from '../ui-style'
import { STUCK_MINUTES_OPTIONS } from '../utils/agent-stuck'
import type { AppCommand } from '../utils/app-commands'
import type { ServerInfo } from '../utils/app-update'
import {
  needsHomeScreenApp,
  notificationSupport,
  notifyWorkerReady,
  requestNotify,
} from '../utils/notify-permission'
import { DevicesSection } from './devices-section'
import { PromptTemplatesSection } from './prompt-templates-section'
import { ShortcutsSection } from './shortcuts-section'
import { SigninsSection } from './signins-section'
import { Button, FOCUS_RING, IconButton } from './ui/button'
import { SegmentedControl } from './ui/segmented-control'
import { Sheet } from './ui/sheet'
import { Switch } from './ui/switch'
import { UpdatesSection } from './updates-section'
import { UserTasksSection } from './user-tasks-section'

interface Props {
  isOpen: boolean
  onClose: () => void
  settings: Settings
  onUpdateSetting: <K extends keyof Settings>(
    key: K,
    value: Settings[K],
  ) => void
  // Shows the welcome screen again (closing Settings)
  onShowWelcome?: () => void
  // Starts the tour (closing Settings)
  onStartTour?: () => void
  // The Updates group: what the server runs, and the reload to its page
  updates?: {
    server: ServerInfo | null
    stale: boolean
    reloading: boolean
    onReload: () => void
  }
  onClearHistory?: () => void
  historyCount?: number
  // Backend has a paste buffer (caps.copyMode); false hides the paste source choice
  tmuxBufferSupported?: boolean
  // Name of the backend's paste buffer in the option label (e.g. "tmux buffer");
  // the backend name is not known here, so the default stays generic.
  pasteBufferLabel?: string
  // Backend lets this device take over the pane size (caps.driveSize)
  driveSizeSupported?: boolean
  // Herdr tabs can show their panes side by side on this device
  layoutViewSupported?: boolean
  // The server sends Web Push (caps.push); turning notifications on then
  // subscribes this device, turning them off unsubscribes it.
  pushAvailable?: boolean
  onEnableNotify?: () => Promise<unknown>
  onDisableNotify?: () => void
  // View-only role: nothing here may change the server (no notifications,
  // which would subscribe this device to Web Push)
  readOnly?: boolean
  // The Devices group: pair, list and revoke devices (caps.devices, full)
  devices?: boolean
  // The Signed-in browsers group: list and sign out the browsers signed in
  // with the password (caps.signins, full)
  signins?: boolean
  // The Prompt templates group (caps.templates); view-only lists and exports
  templates?: boolean
  // The Tasks group: the lines read for Send to agent (caps.tasks) and the
  // user's tasks (caps.userTasks); a full client only
  tasks?: boolean
  userTasks?: boolean
  // Log out, for Signed-in browsers to sign this browser out with
  onLogout?: () => Promise<void> | void
  // Group to show when the sheet opens (About's "Check for updates")
  initialGroup?: string
  // Desktop: the commands whose keys the Shortcuts group changes
  shortcuts?: AppCommand[]
}

const CONTROL =
  'h-9 rounded-control border border-border bg-bg text-[13px] text-fg pointer-coarse:h-touch'

// One line of a settings group: the title (and hint) on the left, the control
// on the right. `htmlFor` makes the title the label of a text field.
function SettingsRow({
  title,
  desc,
  htmlFor,
  children,
}: {
  title: string
  desc?: string
  htmlFor?: string
  children: ReactNode
}) {
  const titleClass =
    'block text-[15px] text-fg ui-terminal:font-label ui-terminal:text-[13px]'
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <div className="min-w-0 flex-1 basis-40">
        {htmlFor ? (
          <label htmlFor={htmlFor} className={titleClass}>
            {title}
          </label>
        ) : (
          <p className={`m-0 ${titleClass}`}>{title}</p>
        )}
        {desc && <p className="m-0 text-[12px] text-fg-muted">{desc}</p>}
      </div>
      {children}
    </div>
  )
}

// A titled block of rows. On desktop only the group picked in the left rail
// shows; on a phone every group stacks in one scrolling sheet.
function SettingsGroup({
  id,
  title,
  active,
  children,
}: {
  id: string
  title: string
  active: boolean
  children: ReactNode
}) {
  const headingId = useId()
  return (
    <section
      data-group={id}
      aria-labelledby={headingId}
      className={`pb-3 ${active ? '' : 'md:hidden'}`}
    >
      <h3
        id={headingId}
        className="m-0 px-4 pb-1.5 pt-3 font-label text-[11px] font-semibold uppercase tracking-wider text-fg-subtle"
      >
        {title}
      </h3>
      <div className="divide-y divide-border border-y border-border ui-native:mx-4 ui-native:overflow-hidden ui-native:rounded-panel ui-native:border-0 ui-neutral:mx-4 ui-neutral:rounded-panel ui-neutral:border">
        {children}
      </div>
    </section>
  )
}

// Terminal font name; saved on blur or Enter, so the terminal is not
// re-measured (and the pane resized) on every keystroke.
function TerminalFontRow({
  value,
  onSave,
}: {
  value: string
  onSave: (value: string) => void
}) {
  const { t } = useT()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const save = () => {
    const next = draft.trim()
    if (next !== value) onSave(next)
  }
  return (
    <SettingsRow
      title={t('settings.font')}
      desc={t('settings.fontDesc')}
      htmlFor="terminal-font"
    >
      <input
        id="terminal-font"
        type="text"
        value={draft}
        // i18n-ignore: a font's name
        placeholder="JetBrainsMono Nerd Font"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        className={`w-36 px-2 ui-terminal:font-label ${CONTROL} ${FOCUS_RING}`}
      />
    </SettingsRow>
  )
}

// The folder names a file search never enters: each removable, one added at
// a time (refused with the reason), and the defaults back in one press.
function ExcludedFoldersRow({
  value,
  onSave,
}: {
  value: string[]
  onSave: (value: string[]) => void
}) {
  const { t } = useT()
  const [name, setName] = useState('')
  const [problem, setProblem] = useState<string>()
  const inputId = useId()
  const errorId = useId()
  const excludeProblem = (n: string) => {
    const key = findExcludeProblem(n)
    return key && t(key)
  }
  const add = () => {
    const next = name.trim()
    const why =
      excludeProblem(next) ??
      (value.includes(next) ? t('settings.excluded.listed') : undefined) ??
      (value.length >= FIND_EXCLUDES_MAX
        ? t('settings.excluded.max', { max: FIND_EXCLUDES_MAX })
        : undefined)
    if (why) {
      setProblem(why)
      return
    }
    onSave([...value, next])
    setName('')
  }
  const isDefault =
    value.length === FIND_EXCLUDES_DEFAULT.length &&
    value.every((v, i) => v === FIND_EXCLUDES_DEFAULT[i])
  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
      <div>
        <label
          htmlFor={inputId}
          className="block text-[15px] text-fg ui-terminal:font-label ui-terminal:text-[13px]"
        >
          {t('settings.excluded')}
        </label>
        <p className="m-0 text-[12px] text-fg-muted">
          {t('settings.excludedDesc')}
        </p>
      </div>
      <ul
        aria-label={t('settings.excluded.list')}
        className="flex flex-wrap gap-1.5"
      >
        {value.map((v) => (
          <li
            key={v}
            className="flex items-center gap-0.5 rounded-control border border-border bg-bg pl-2 font-term text-[12px] text-fg"
          >
            {v}
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={t('settings.excluded.remove', { name: v })}
              onClick={() => onSave(value.filter((x) => x !== v))}
            >
              <X size={12} aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="text"
          value={name}
          placeholder={t('settings.excluded.placeholder')}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? errorId : undefined}
          onChange={(e) => {
            setName(e.target.value)
            setProblem(undefined)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            add()
          }}
          className={`w-40 px-2 font-term ${CONTROL} ${FOCUS_RING}`}
        />
        <Button size="sm" onClick={add}>
          {t('settings.excluded.add')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={isDefault}
          onClick={() => {
            onSave(FIND_EXCLUDES_DEFAULT)
            setProblem(undefined)
          }}
        >
          {t('settings.excluded.reset')}
        </Button>
      </div>
      {problem && (
        <p id={errorId} role="alert" className="m-0 text-[12px] text-danger">
          {problem}
        </p>
      )}
    </div>
  )
}

const formatSeconds = (s: number, t: Translate<MessageKey>) =>
  s >= 60
    ? t('settings.pollMinutes', { n: s / 60 })
    : t('settings.pollSeconds', { n: s })

const POLL_INTERVAL_OPTIONS = [3, 5, 10, 15, 30, 60, 120, 300]

const IME_SEND_OPTIONS: {
  value: ImeSendBehavior
  label: MessageKey
  desc: MessageKey
}[] = [
  {
    value: 'send-only',
    label: 'settings.ime.sendOnly',
    desc: 'settings.ime.sendOnlyDesc',
  },
  {
    value: 'send-enter',
    label: 'settings.ime.sendEnter',
    desc: 'settings.ime.sendEnterDesc',
  },
]

function pasteSourceOptions(
  bufferLabel: string,
  t: Translate<MessageKey>,
): {
  value: PasteSource
  label: string
  desc: string
}[] {
  return [
    {
      value: 'clipboard',
      label: t('settings.paste.clipboard'),
      desc: t('settings.paste.clipboardDesc'),
    },
    {
      // The stored value stays 'tmux' (the localStorage schema is unchanged)
      value: 'tmux',
      label: bufferLabel,
      desc: t('settings.paste.bufferDesc'),
    },
  ]
}

// Notify when an agent needs me. Turning it on asks for the permission first
// thing in the click (Safari asks only from a gesture), then subscribes this
// device to Web Push in the same click when the server sends it; it stays
// off while the browser blocks notifications or the active service worker
// predates the click handler.
function NotifyAgentsRow({
  enabled,
  onChange,
  pushAvailable,
  onEnable,
  onDisable,
}: {
  enabled: boolean
  onChange: (on: boolean) => void
  pushAvailable: boolean
  onEnable?: () => Promise<unknown>
  onDisable?: () => void
}) {
  const { t } = useT()
  const [permission, setPermission] = useState(notificationSupport)
  // undefined while the worker is asked
  const [workerReady, setWorkerReady] = useState<boolean>()
  const [homeScreenOnly] = useState(needsHomeScreenApp)
  useEffect(() => {
    let live = true
    notifyWorkerReady().then((ready) => {
      if (live) setWorkerReady(ready)
    })
    return () => {
      live = false
    }
  }, [])
  if (permission === 'unsupported' && !homeScreenOnly) return null
  const checked = enabled && permission === 'granted'
  const desc = t(
    homeScreenOnly
      ? 'settings.notify.homeScreen'
      : permission === 'denied'
        ? 'settings.notify.denied'
        : workerReady === false
          ? 'settings.notify.reload'
          : 'settings.notify.desc',
  )
  const toggle = async (on: boolean) => {
    if (!on) {
      onChange(false)
      onDisable?.()
      return
    }
    const result = await requestNotify()
    setPermission(result)
    if (result !== 'granted') return
    // Nothing awaited between the permission and the subscribe.
    const subscribed = pushAvailable ? onEnable?.() : undefined
    onChange(true)
    await subscribed
  }
  return (
    <SettingsRow title={t('settings.notify')} desc={desc}>
      <Switch
        label={t('settings.notify')}
        checked={checked}
        disabled={
          !checked &&
          (homeScreenOnly || permission === 'denied' || !workerReady)
        }
        onChange={toggle}
      />
    </SettingsRow>
  )
}

// A tiny drawing of each style's shape: corner radius, hairline or raised.
const STYLE_PREVIEW: Record<UiStyle, string> = {
  terminal: 'rounded-[2px] border border-border-strong bg-bg',
  native: 'rounded-[6px] bg-surface-raised shadow-sm ring-1 ring-border',
  neutral: 'rounded-[4px] border border-border-strong bg-surface',
}

function StylePreview({ style }: { style: UiStyle }) {
  return (
    <span
      aria-hidden="true"
      data-preview={style}
      className={`mr-1.5 flex h-4 w-6 flex-col justify-center gap-0.5 px-1 ${STYLE_PREVIEW[style]}`}
    >
      <span className="h-0.5 w-full rounded-full bg-accent" />
      <span className="h-0.5 w-2/3 rounded-full bg-fg-subtle" />
    </span>
  )
}

const STYLE_LABEL: Record<UiStyle, MessageKey> = {
  neutral: 'settings.style.neutral',
  terminal: 'settings.style.terminal',
  native: 'settings.style.native',
}

interface GroupDef {
  id: string
  title: string
  rows: ReactNode
}

export function SettingsModal({
  isOpen,
  onClose,
  settings,
  onUpdateSetting,
  onShowWelcome,
  onStartTour,
  updates,
  onClearHistory,
  historyCount = 0,
  tmuxBufferSupported = true,
  pasteBufferLabel,
  driveSizeSupported = false,
  layoutViewSupported = false,
  pushAvailable = false,
  onEnableNotify,
  onDisableNotify,
  readOnly = false,
  devices = false,
  signins = false,
  templates = false,
  tasks = false,
  userTasks = false,
  onLogout,
  initialGroup,
  shortcuts,
}: Props) {
  const { t } = useT()
  const [activeGroup, setActiveGroup] = useState('appearance')

  // Opened for one group: pick it in the desktop rail, and on a phone, where
  // every group stacks, scroll it to the top once the sheet has mounted.
  useEffect(() => {
    if (!isOpen || !initialGroup) return
    setActiveGroup(initialGroup)
    const frame = requestAnimationFrame(() => {
      document
        .querySelector(`[data-group="${initialGroup}"]`)
        // jsdom has no scrollIntoView
        ?.scrollIntoView?.({ block: 'start' })
    })
    return () => cancelAnimationFrame(frame)
  }, [isOpen, initialGroup])

  const imeOption = IME_SEND_OPTIONS.find(
    (o) => o.value === settings.imeSendBehavior,
  )
  const pasteOptions = pasteSourceOptions(
    pasteBufferLabel ?? t('shell.buffer.session'),
    t,
  )
  const pasteOption = pasteOptions.find((o) => o.value === settings.pasteSource)
  const hasActions = onShowWelcome || onStartTour || onClearHistory

  const groups: GroupDef[] = [
    {
      id: 'appearance',
      title: t('settings.group.appearance'),
      rows: (
        <>
          <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
            <div>
              <p className="m-0 text-[15px] text-fg ui-terminal:font-label ui-terminal:text-[13px]">
                {t('settings.style')}
              </p>
              <p className="m-0 text-[12px] text-fg-muted">
                {t('settings.styleDesc')}
              </p>
            </div>
            <SegmentedControl
              label={t('settings.style')}
              options={UI_STYLES.map((s) => ({
                value: s.id,
                label: t(STYLE_LABEL[s.id]),
                content: (
                  <>
                    <StylePreview style={s.id} />
                    {t(STYLE_LABEL[s.id])}
                  </>
                ),
              }))}
              value={settings.uiStyle}
              onChange={(v) => onUpdateSetting('uiStyle', v)}
              className="self-start"
            />
          </div>
          <SettingsRow
            title={t('settings.language')}
            desc={t('settings.languageDesc')}
          >
            <SegmentedControl
              label={t('settings.language')}
              options={[
                { value: 'auto', content: t('settings.languageAuto') },
                { value: 'en', content: t('common.english') },
                { value: 'vi', content: t('common.vietnamese') },
              ]}
              value={settings.language}
              onChange={(v) => onUpdateSetting('language', v)}
            />
          </SettingsRow>
        </>
      ),
    },
    {
      id: 'keyboard',
      title: t('settings.group.keyboard'),
      rows: (
        <>
          <SettingsRow
            title={t('settings.ime')}
            desc={imeOption && t(imeOption.desc)}
          >
            <SegmentedControl
              label={t('settings.ime')}
              options={IME_SEND_OPTIONS.map((o) => ({
                value: o.value,
                label: t(o.label),
                content: t(o.label),
              }))}
              value={settings.imeSendBehavior}
              onChange={(v) => onUpdateSetting('imeSendBehavior', v)}
            />
          </SettingsRow>
          {tmuxBufferSupported && (
            <SettingsRow title={t('settings.paste')} desc={pasteOption?.desc}>
              <SegmentedControl
                label={t('settings.paste')}
                options={pasteOptions.map((o) => ({
                  value: o.value,
                  label: o.label,
                  content: o.label,
                }))}
                value={settings.pasteSource}
                onChange={(v) => onUpdateSetting('pasteSource', v)}
              />
            </SettingsRow>
          )}
          <SettingsRow
            title={t('settings.toolbarExpanded')}
            desc={t('settings.toolbarExpandedDesc')}
          >
            <Switch
              label={t('settings.toolbarExpanded')}
              checked={settings.toolbarDefaultExpanded}
              onChange={(v) => onUpdateSetting('toolbarDefaultExpanded', v)}
            />
          </SettingsRow>
        </>
      ),
    },
    ...(shortcuts
      ? [
          {
            id: 'shortcuts',
            title: t('settings.group.shortcuts'),
            rows: <ShortcutsSection commands={shortcuts} />,
          },
        ]
      : []),
    {
      id: 'terminal',
      title: t('common.terminal'),
      rows: (
        <>
          <TerminalFontRow
            value={settings.terminalFont}
            onSave={(v) => onUpdateSetting('terminalFont', v)}
          />
          <SettingsRow
            title={t('settings.contextMenu')}
            desc={t('settings.contextMenuDesc')}
          >
            <Switch
              label={t('settings.contextMenu')}
              checked={settings.disableContextMenu}
              onChange={(v) => onUpdateSetting('disableContextMenu', v)}
            />
          </SettingsRow>
          <SettingsRow
            title={t('settings.copyOnSelect')}
            desc={t('settings.copyOnSelectDesc')}
          >
            <Switch
              label={t('settings.copyOnSelect')}
              checked={settings.copyOnSelect}
              onChange={(v) => onUpdateSetting('copyOnSelect', v)}
            />
          </SettingsRow>
          {layoutViewSupported && (
            <SettingsRow
              title={t('settings.layoutView')}
              desc={t('settings.layoutViewDesc')}
            >
              <Switch
                label={t('settings.layoutView')}
                checked={settings.herdrLayoutView}
                onChange={(v) => onUpdateSetting('herdrLayoutView', v)}
              />
            </SettingsRow>
          )}
          {driveSizeSupported && (
            <SettingsRow
              title={t('settings.fitPane')}
              desc={t('settings.fitPaneDesc')}
            >
              <Switch
                label={t('settings.fitPane')}
                checked={settings.driveTerminalSize}
                onChange={(v) => onUpdateSetting('driveTerminalSize', v)}
              />
            </SettingsRow>
          )}
        </>
      ),
    },
    {
      id: 'sessions',
      title: t('settings.group.sessions'),
      rows: (
        <>
          <SettingsRow title={t('settings.tabs')} desc={t('settings.tabsDesc')}>
            <Switch
              label={t('settings.tabs')}
              checked={settings.showSessionTabs}
              onChange={(v) => onUpdateSetting('showSessionTabs', v)}
            />
          </SettingsRow>
          <SettingsRow
            title={t('settings.blockedFirst')}
            desc={t('settings.blockedFirstDesc')}
          >
            <Switch
              label={t('settings.blockedFirst')}
              checked={settings.sortBlockedFirst}
              onChange={(v) => onUpdateSetting('sortBlockedFirst', v)}
            />
          </SettingsRow>
          {!readOnly && (
            <NotifyAgentsRow
              enabled={settings.notifyAgents}
              onChange={(v) => onUpdateSetting('notifyAgents', v)}
              pushAvailable={pushAvailable}
              onEnable={onEnableNotify}
              onDisable={onDisableNotify}
            />
          )}
          <SettingsRow
            title={t('settings.stuck')}
            desc={t('settings.stuckDesc', { minutes: settings.stuckMinutes })}
          >
            <select
              aria-label={t('settings.stuckAfter')}
              value={settings.stuckMinutes}
              onChange={(e) =>
                onUpdateSetting('stuckMinutes', Number(e.target.value))
              }
              className={`px-2 ${CONTROL} ${FOCUS_RING}`}
            >
              {STUCK_MINUTES_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {t('settings.minutes', { n: v })}
                </option>
              ))}
            </select>
          </SettingsRow>
          <SettingsRow
            title={t('settings.usage')}
            desc={t('settings.usageDesc')}
          >
            <Switch
              label={t('settings.usage')}
              checked={settings.showUsageChip}
              onChange={(v) => onUpdateSetting('showUsageChip', v)}
            />
          </SettingsRow>
          <SettingsRow
            title={t('settings.poll')}
            desc={t('settings.pollDesc', {
              interval: formatSeconds(settings.pollInterval, t),
            })}
          >
            <select
              aria-label={t('settings.poll')}
              value={settings.pollInterval}
              onChange={(e) =>
                onUpdateSetting('pollInterval', Number(e.target.value))
              }
              className={`px-2 ${CONTROL} ${FOCUS_RING}`}
            >
              {POLL_INTERVAL_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {formatSeconds(v, t)}
                </option>
              ))}
            </select>
          </SettingsRow>
        </>
      ),
    },
  ]

  groups.push({
    id: 'files',
    title: t('common.files'),
    rows: (
      <>
        <ExcludedFoldersRow
          value={settings.findExcludes}
          onSave={(v) => onUpdateSetting('findExcludes', v)}
        />
        <SettingsRow title={t('settings.wrap')} desc={t('settings.wrapDesc')}>
          <Switch
            label={t('settings.wrap')}
            checked={settings.editorWrap}
            onChange={(v) => onUpdateSetting('editorWrap', v)}
          />
        </SettingsRow>
        <SettingsRow
          title={t('settings.fontSize')}
          desc={t('settings.fontSizeDesc')}
        >
          <select
            aria-label={t('settings.fontSize')}
            value={settings.editorFontSize}
            onChange={(e) =>
              onUpdateSetting('editorFontSize', Number(e.target.value))
            }
            className={`px-2 ${CONTROL} ${FOCUS_RING}`}
          >
            {EDITOR_FONT_SIZES.map((v) => (
              <option key={v} value={v}>
                {t('settings.px', { n: v })}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow
          title={t('settings.tabSize')}
          desc={t('settings.tabSizeDesc')}
        >
          <select
            aria-label={t('settings.tabSize')}
            value={settings.editorTabSize}
            onChange={(e) =>
              onUpdateSetting(
                'editorTabSize',
                Number(e.target.value) as EditorTabSize,
              )
            }
            className={`px-2 ${CONTROL} ${FOCUS_RING}`}
          >
            {EDITOR_TAB_SIZES.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </SettingsRow>
        <SettingsRow title={t('settings.vim')} desc={t('settings.vimDesc')}>
          <Switch
            label={t('settings.vim')}
            checked={settings.editorVim}
            onChange={(v) => onUpdateSetting('editorVim', v)}
          />
        </SettingsRow>
      </>
    ),
  })

  if (devices) {
    groups.push({
      id: 'devices',
      title: t('settings.group.devices'),
      rows: <DevicesSection />,
    })
  }

  if (signins) {
    groups.push({
      id: 'signins',
      title: t('settings.group.signins'),
      rows: <SigninsSection logOut={onLogout} />,
    })
  }

  if (templates) {
    groups.push({
      id: 'templates',
      title: t('settings.group.templates'),
      rows: <PromptTemplatesSection readOnly={readOnly} />,
    })
  }

  if (!readOnly && (tasks || userTasks)) {
    groups.push({
      id: 'tasks',
      title: t('common.tasks'),
      rows: (
        <>
          {tasks && (
            <SettingsRow
              title={t('settings.taskHistory')}
              desc={t('settings.taskHistoryDesc')}
            >
              <select
                aria-label={t('settings.taskHistory')}
                value={settings.taskHistoryLines}
                onChange={(e) =>
                  onUpdateSetting('taskHistoryLines', Number(e.target.value))
                }
                className={`px-2 ${CONTROL} ${FOCUS_RING}`}
              >
                {TASK_HISTORY_LINE_CHOICES.map((v) => (
                  <option key={v} value={v}>
                    {t('settings.taskLines', { n: v })}
                  </option>
                ))}
              </select>
            </SettingsRow>
          )}
          {userTasks && <UserTasksSection />}
        </>
      ),
    })
  }

  if (updates) {
    groups.push({
      id: 'updates',
      title: t('settings.group.updates'),
      rows: <UpdatesSection {...updates} />,
    })
  }

  if (hasActions) {
    groups.push({
      id: 'data',
      title: t('settings.group.data'),
      rows: (
        <div className="flex flex-col gap-1 px-4 py-2.5 ui-native:bg-surface-raised">
          {onShowWelcome && (
            <Button variant="ghost" onClick={onShowWelcome}>
              {t('settings.showWelcome')}
            </Button>
          )}
          {onStartTour && (
            <Button variant="ghost" onClick={onStartTour}>
              {t('settings.takeTour')}
            </Button>
          )}
          {onClearHistory && (
            <Button
              variant="danger"
              disabled={historyCount === 0}
              onClick={onClearHistory}
            >
              <Trash2 size={16} aria-hidden="true" />
              {t('settings.clearHistory', { count: historyCount })}
            </Button>
          )}
        </div>
      ),
    })
  }

  // A group can vanish (Data & help without handlers) while it is selected
  const shownGroup = groups.some((g) => g.id === activeGroup)
    ? activeGroup
    : groups[0].id

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title={t('common.settings')}
      // Full screen on a phone, a two-column dialog on desktop. Full screen
      // reaches under the status bar of a notched phone, so the header is
      // pushed below it.
      className="max-md:h-(--app-height) max-md:max-h-(--app-height) max-md:pt-[env(safe-area-inset-top)] md:h-[34rem] md:max-w-3xl"
    >
      <div className="md:flex md:min-h-full">
        <nav
          aria-label={t('settings.groups')}
          className="hidden md:sticky md:top-0 md:flex md:w-44 md:shrink-0 md:flex-col md:gap-0.5 md:self-start md:border-r md:border-border md:p-2"
        >
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-current={g.id === shownGroup ? 'true' : undefined}
              onClick={() => setActiveGroup(g.id)}
              className={`h-9 rounded-control px-3 text-left pointer-coarse:h-touch text-[14px] ui-terminal:font-label ui-terminal:text-[13px] ${FOCUS_RING} ${
                g.id === shownGroup
                  ? 'bg-accent-soft font-medium text-fg'
                  : 'text-fg-muted hover:bg-surface hover:text-fg'
              }`}
            >
              {g.title}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {groups.map((g) => (
            <SettingsGroup
              key={g.id}
              id={g.id}
              title={g.title}
              active={g.id === shownGroup}
            >
              {g.rows}
            </SettingsGroup>
          ))}
        </div>
      </div>
    </Sheet>
  )
}
