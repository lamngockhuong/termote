import { ChevronLeft, ChevronRight, Trash2, X } from 'lucide-react'
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { THEMES, useTheme } from '../contexts/theme-context'
import {
  onViewerEntryGone,
  useHistoryClose,
  viewerClosing,
} from '../hooks/use-history-close'
import { useIsMobile } from '../hooks/use-media-query'
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
// on the right; `stack` puts the control under the title instead, for a choice
// of three or more. `htmlFor` makes the title the label of a text field.
function SettingsRow({
  title,
  desc,
  htmlFor,
  layout = 'inline',
  children,
}: {
  title: string
  desc?: string
  htmlFor?: string
  layout?: 'inline' | 'stack'
  children: ReactNode
}) {
  const titleClass =
    'block text-[15px] text-fg ui-terminal:font-label ui-terminal:text-[13px]'
  return (
    <div
      className={`flex px-4 py-2.5 ui-native:bg-surface-raised ${
        layout === 'stack'
          ? 'flex-col gap-2'
          : 'min-h-14 flex-wrap items-center gap-x-3 gap-y-2'
      }`}
    >
      <div className={layout === 'stack' ? '' : 'min-w-0 flex-1 basis-40'}>
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

// The rows of a group, and on a phone the list of groups: a hairline between
// items, a card in the native and neutral styles
const ITEM_LIST =
  'divide-y divide-border border-y border-border ui-native:mx-4 ui-native:overflow-hidden ui-native:rounded-panel ui-native:border-0 ui-neutral:mx-4 ui-neutral:rounded-panel ui-neutral:border'

// A titled block of rows. Only the group picked shows: in the left rail on
// desktop, from the list of groups on a phone.
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
      className={`pb-3 pt-3 ${active ? '' : 'hidden'}`}
    >
      {/* The rail (desktop) or the sheet's title (phone) already names the
          group, so only a screen reader hears the heading; pt-3 keeps the
          gap it left, so the rows' top line does not run into the header's */}
      <h3
        id={headingId}
        className="m-0 px-4 pb-1.5 pt-3 font-label text-[11px] font-semibold uppercase tracking-wider text-fg-subtle sr-only"
      >
        {title}
      </h3>
      <div className={ITEM_LIST}>{children}</div>
    </section>
  )
}

// A phone's way back from a group to the list: the ‹ before the title, and
// Back (a gesture, a button, Android's) through an entry of its own in the
// history, taken off again however the group is left. useHistoryClose keeps
// one such entry for the whole page; Settings is modal, so no image viewer
// can open over it and hold the other.
function PhoneBackButton({
  onBack,
  backRef,
  byKeyboard,
}: {
  onBack: () => void
  // Lets Android's Back, which reaches the dialog as a close request, take
  // the same way
  backRef: RefObject<(() => void) | null>
  // Set when Enter or Space pressed it (a click with no detail)
  byKeyboard: RefObject<boolean>
}) {
  const { t } = useT()
  const back = useHistoryClose(onBack)
  useEffect(() => {
    backRef.current = back
    return () => {
      backRef.current = null
    }
  }, [back, backRef])
  return (
    <IconButton
      aria-label={t('settings.back')}
      data-phone-back=""
      onClick={(e) => {
        byKeyboard.current = e.detail === 0
        back()
      }}
    >
      <ChevronLeft size={20} aria-hidden="true" />
    </IconButton>
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
    <SettingsRow
      title={t('settings.excluded')}
      desc={t('settings.excludedDesc')}
      htmlFor={inputId}
      layout="stack"
    >
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
    </SettingsRow>
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

// Light, dark or the system's: the same choice as the ⋯ menu, saved by the
// theme context rather than with the other settings
function ThemeRow() {
  const { t } = useT()
  const { theme, setTheme } = useTheme()
  return (
    <SettingsRow title={t('shell.menu.theme')} layout="stack">
      <SegmentedControl
        label={t('shell.menu.theme')}
        options={THEMES.map(({ value, label, Icon }) => ({
          value,
          label: t(label),
          content: (
            <>
              <Icon size={14} aria-hidden="true" className="mr-1.5" />
              {t(label)}
            </>
          ),
        }))}
        value={theme}
        onChange={setTheme}
        className="self-start"
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
  // Under the title in a phone's list: what the group is set to now
  summary?: string
}

const LANGUAGE_LABEL: Record<Settings['language'], MessageKey> = {
  auto: 'settings.languageAuto',
  en: 'common.english',
  vi: 'common.vietnamese',
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
  const { theme } = useTheme()
  const isMobile = useIsMobile()
  const [activeGroup, setActiveGroup] = useState('appearance')
  // A phone shows the list of groups, or one group with a way back to it
  const [phoneList, setPhoneList] = useState(true)
  const navId = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  // The group a phone just left, to focus in the list again
  const leftGroup = useRef<string | null>(null)

  // Each opening starts over: at the group it is given (About's "Check for
  // updates"), picked in the rail and opened on a phone, or at the list. Set
  // while rendering, so a phone never draws the list first.
  const openKey = isOpen ? (initialGroup ?? '') : null
  const [seenKey, setSeenKey] = useState<string | null>(null)
  if (openKey !== seenKey) {
    setSeenKey(openKey)
    setPhoneList(!initialGroup || !isOpen)
    if (isOpen && initialGroup) setActiveGroup(initialGroup)
  }
  // Down to a phone's width while open: back at the list
  const [wasMobile, setWasMobile] = useState(isMobile)
  if (isMobile !== wasMobile) {
    setWasMobile(isMobile)
    if (isMobile) setPhoneList(true)
  }
  const phoneGroup = isOpen && isMobile && !phoneList

  // A group just opened from the list, to focus its way back
  const enteredGroup = useRef(false)
  // Whether the last move between the list and a group came from a key.
  // Focus still moves on a tap, but without a ring: Safari draws one for any
  // focus() that follows a touch.
  const byKeyboard = useRef(false)
  // Set while a tap waits for the Back of the group just left
  const stopWaiting = useRef<(() => void) | null>(null)
  useEffect(() => () => stopWaiting.current?.(), [])

  const openGroup = (id: string) => {
    setActiveGroup(id)
    if (!isMobile) return
    // The entry of the group just left is still being popped: one pushed
    // now would sit on top of it, and its popstate would close the new group.
    // Open once it is gone; another tap meanwhile only changes the group.
    if (viewerClosing()) {
      stopWaiting.current ??= onViewerEntryGone(() => {
        stopWaiting.current?.()
        stopWaiting.current = null
        enteredGroup.current = true
        setPhoneList(false)
      })
      return
    }
    enteredGroup.current = true
    setPhoneList(false)
  }

  // Bumped to push the group's history entry again (a new PhoneBackButton)
  const [historyKey, setHistoryKey] = useState(0)
  const phoneBack = useRef<(() => void) | null>(null)

  const backToList = () => {
    // Back while a sheet of the group is open over it (a template being
    // edited, a confirmation): that sheet is the top layer, so the group
    // stays, with a new entry for the next Back; the sheet closes by its
    // own buttons. Leaving the group would drop what was typed in it.
    const settings = contentRef.current?.closest('dialog')
    const childOpen = [...document.querySelectorAll('dialog[open]')].some(
      (d) => d !== settings,
    )
    if (childOpen) {
      setHistoryKey((k) => k + 1)
      return
    }
    leftGroup.current = activeGroup
    setPhoneList(true)
  }

  // Escape closes Settings at either level. Android's Back reaches the dialog
  // as the same close request (cancel) without the key, and leaves a group
  // for the list as Back of the history does.
  const escapePressed = useRef(false)
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      escapePressed.current = true
      // The cancel follows within the same task
      setTimeout(() => {
        escapePressed.current = false
      })
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [isOpen])
  const cancel = () => {
    if (!escapePressed.current && phoneBack.current) phoneBack.current()
    else onClose()
  }

  // A group opens at its top, and the list again with focus on the group
  // just left (a keyboard or screen reader keeps its place)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the view changes
  useLayoutEffect(() => {
    // The sheet's scrolling body holds this content
    const body = contentRef.current?.parentElement
    if (body && isMobile) body.scrollTop = 0
    // Into a group from the list: its way back has focus, so a keyboard or
    // screen reader does not start over from the top of the page
    if (isMobile && !phoneList && enteredGroup.current) {
      enteredGroup.current = false
      document
        .querySelector<HTMLElement>('[data-phone-back]')
        ?.focus({ focusVisible: byKeyboard.current })
      byKeyboard.current = false
    }
    if (!isMobile || !phoneList || !leftGroup.current) return
    document
      .querySelector<HTMLElement>(`[data-group-button="${leftGroup.current}"]`)
      ?.focus({ focusVisible: byKeyboard.current })
    leftGroup.current = null
    byKeyboard.current = false
  }, [isMobile, phoneList, activeGroup])

  const imeOption = IME_SEND_OPTIONS.find(
    (o) => o.value === settings.imeSendBehavior,
  )
  const pasteOptions = pasteSourceOptions(
    pasteBufferLabel ?? t('shell.buffer.session'),
    t,
  )
  const pasteOption = pasteOptions.find((o) => o.value === settings.pasteSource)
  const hasActions = onShowWelcome || onStartTour || onClearHistory

  const themeLabel = THEMES.find((m) => m.value === theme)?.label
  const groups: GroupDef[] = [
    {
      id: 'appearance',
      title: t('settings.group.appearance'),
      summary: [
        t(STYLE_LABEL[settings.uiStyle]),
        themeLabel && t(themeLabel),
        t(LANGUAGE_LABEL[settings.language]),
      ]
        .filter(Boolean)
        .join(' · '),
      rows: (
        <>
          <SettingsRow
            title={t('settings.style')}
            desc={t('settings.styleDesc')}
            layout="stack"
          >
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
          </SettingsRow>
          <ThemeRow />
          <SettingsRow
            title={t('settings.language')}
            desc={t('settings.languageDesc')}
            layout="stack"
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
              className="self-start"
            />
          </SettingsRow>
        </>
      ),
    },
    {
      id: 'keyboard',
      title: t('settings.group.keyboard'),
      summary: imeOption && t(imeOption.label),
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

  const shown = groups.find((g) => g.id === shownGroup)
  // A phone shows the list or one group, never both
  const showList = !isMobile || phoneList
  const showGroups = !isMobile || !phoneList

  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title={phoneGroup && shown ? shown.title : t('common.settings')}
      onCancel={cancel}
      leading={
        phoneGroup && (
          <PhoneBackButton
            key={historyKey}
            onBack={backToList}
            backRef={phoneBack}
            byKeyboard={byKeyboard}
          />
        )
      }
      // Full screen on a phone, a two-column dialog on desktop. Full screen
      // reaches under the status bar of a notched phone, so the header is
      // pushed below it.
      className="max-md:h-(--app-height) max-md:max-h-(--app-height) max-md:pt-[env(safe-area-inset-top)] md:h-[34rem] md:max-w-3xl"
    >
      <div ref={contentRef} className="md:flex md:min-h-full">
        {showList && (
          <nav
            aria-label={t('settings.groups')}
            className={
              isMobile
                ? `mt-3 flex flex-col ${ITEM_LIST}`
                : 'sticky top-0 flex w-48 shrink-0 flex-col gap-0.5 self-start border-r border-border p-2'
            }
          >
            {groups.map((g) =>
              isMobile ? (
                <button
                  key={g.id}
                  type="button"
                  data-group-button={g.id}
                  // Named by the group alone; the summary describes it
                  aria-labelledby={`${navId}-${g.id}-name`}
                  aria-describedby={g.summary ? `${navId}-${g.id}` : undefined}
                  onClick={(e) => {
                    byKeyboard.current = e.detail === 0
                    openGroup(g.id)
                  }}
                  className={`flex min-h-touch w-full items-center gap-3 px-4 py-2 text-left ui-native:bg-surface-raised ${FOCUS_RING} focus-visible:-outline-offset-2`}
                >
                  <span className="min-w-0 flex-1">
                    <span
                      id={`${navId}-${g.id}-name`}
                      className="block text-[15px] text-fg ui-terminal:font-label ui-terminal:text-[13px]"
                    >
                      {g.title}
                    </span>
                    {g.summary && (
                      <span
                        id={`${navId}-${g.id}`}
                        className="block truncate text-[12px] text-fg-muted"
                      >
                        {g.summary}
                      </span>
                    )}
                  </span>
                  <ChevronRight
                    size={16}
                    aria-hidden="true"
                    className="shrink-0 text-fg-subtle"
                  />
                </button>
              ) : (
                <button
                  key={g.id}
                  type="button"
                  data-group-button={g.id}
                  aria-current={g.id === shownGroup ? 'true' : undefined}
                  onClick={() => openGroup(g.id)}
                  // Grows with its label: a long one wraps to a second line
                  // rather than spilling onto the next button
                  className={`min-h-9 rounded-control px-3 py-1.5 text-left leading-snug pointer-coarse:min-h-touch text-[14px] ui-terminal:font-label ui-terminal:text-[13px] ${FOCUS_RING} ${
                    g.id === shownGroup
                      ? 'bg-accent-soft font-semibold text-fg ui-terminal:shadow-[inset_2px_0_0_var(--color-accent)]'
                      : 'text-fg-muted hover:bg-surface hover:text-fg'
                  }`}
                >
                  {g.title}
                </button>
              ),
            )}
          </nav>
        )}
        {showGroups && (
          <div className="min-w-0 flex-1">
            {/* Desktop keeps every group mounted (a draft in one survives
                switching); a phone draws only the one open */}
            {(isMobile && shown ? [shown] : groups).map((g) => (
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
        )}
      </div>
    </Sheet>
  )
}
