import { RefreshCw, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type {
  ImeSendBehavior,
  PasteSource,
  Settings,
} from '../hooks/use-settings'
import { UI_STYLES, type UiStyle } from '../ui-style'
import { Button, FOCUS_RING } from './ui/button'
import { SegmentedControl } from './ui/segmented-control'
import { Sheet } from './ui/sheet'
import { Switch } from './ui/switch'

interface Props {
  isOpen: boolean
  onClose: () => void
  settings: Settings
  onUpdateSetting: <K extends keyof Settings>(
    key: K,
    value: Settings[K],
  ) => void
  onShowGestureHints?: () => void
  onCheckForUpdate?: () => Promise<string | null>
  updateChecking?: boolean
  onClearHistory?: () => void
  historyCount?: number
  // Backend has a paste buffer (caps.copyMode); false hides the paste source choice
  tmuxBufferSupported?: boolean
  // Name of the backend's paste buffer in the option label (e.g. "tmux buffer");
  // the backend name is not known here, so the default stays generic.
  pasteBufferLabel?: string
  // Backend lets this device take over the pane size (caps.driveSize)
  driveSizeSupported?: boolean
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
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const save = () => {
    const next = draft.trim()
    if (next !== value) onSave(next)
  }
  return (
    <SettingsRow
      title="Terminal font"
      desc="A font installed on this device (e.g. a Nerd Font). Nerd Font icons work without one."
      htmlFor="terminal-font"
    >
      <input
        id="terminal-font"
        type="text"
        value={draft}
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

const formatSeconds = (s: number) => (s >= 60 ? `${s / 60}m` : `${s}s`)

const POLL_INTERVAL_OPTIONS = [3, 5, 10, 15, 30, 60, 120, 300]

const IME_SEND_OPTIONS: {
  value: ImeSendBehavior
  label: string
  desc: string
}[] = [
  {
    value: 'send-only',
    label: 'Send text only',
    desc: 'Send text to terminal without Enter',
  },
  {
    value: 'send-enter',
    label: 'Send + Enter',
    desc: 'Send text then press Enter automatically',
  },
]

function pasteSourceOptions(bufferLabel: string): {
  value: PasteSource
  label: string
  desc: string
}[] {
  return [
    {
      value: 'clipboard',
      label: 'System clipboard',
      desc: 'Paste from device clipboard (Ctrl+Shift+V)',
    },
    {
      // The stored value stays 'tmux' (the localStorage schema is unchanged)
      value: 'tmux',
      label: bufferLabel,
      desc: 'Paste from the copy mode buffer',
    },
  ]
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

const STYLE_OPTIONS = UI_STYLES.map((s) => ({
  value: s.id,
  label: s.label,
  content: (
    <>
      <StylePreview style={s.id} />
      {s.label}
    </>
  ),
}))

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
  onShowGestureHints,
  onCheckForUpdate,
  updateChecking,
  onClearHistory,
  historyCount = 0,
  tmuxBufferSupported = true,
  pasteBufferLabel = 'Session buffer',
  driveSizeSupported = false,
}: Props) {
  const [inlineToast, setInlineToast] = useState<string | null>(null)
  const [activeGroup, setActiveGroup] = useState('appearance')
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>(null)

  // Cleanup toast timer on unmount
  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    },
    [],
  )

  const imeOption = IME_SEND_OPTIONS.find(
    (o) => o.value === settings.imeSendBehavior,
  )
  const pasteOptions = pasteSourceOptions(pasteBufferLabel)
  const pasteOption = pasteOptions.find((o) => o.value === settings.pasteSource)
  const hasActions = onShowGestureHints || onCheckForUpdate || onClearHistory

  // Adding a group (e.g. Devices) is one more entry here.
  const groups: GroupDef[] = [
    {
      id: 'appearance',
      title: 'Appearance',
      rows: (
        <div className="flex flex-col gap-2 px-4 py-2.5 ui-native:bg-surface-raised">
          <div>
            <p className="m-0 text-[15px] text-fg ui-terminal:font-label ui-terminal:text-[13px]">
              Interface style
            </p>
            <p className="m-0 text-[12px] text-fg-muted">
              Applies at once. Theme stays in the ⋯ menu.
            </p>
          </div>
          <SegmentedControl
            label="Interface style"
            options={STYLE_OPTIONS}
            value={settings.uiStyle}
            onChange={(v) => onUpdateSetting('uiStyle', v)}
            className="self-start"
          />
        </div>
      ),
    },
    {
      id: 'keyboard',
      title: 'Keyboard',
      rows: (
        <>
          <SettingsRow title="Text input send behavior" desc={imeOption?.desc}>
            <SegmentedControl
              label="Text input send behavior"
              options={IME_SEND_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
                content: o.label,
              }))}
              value={settings.imeSendBehavior}
              onChange={(v) => onUpdateSetting('imeSendBehavior', v)}
            />
          </SettingsRow>
          {tmuxBufferSupported && (
            <SettingsRow title="Paste button source" desc={pasteOption?.desc}>
              <SegmentedControl
                label="Paste button source"
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
            title="Toolbar default expanded"
            desc="Show all keys when toolbar loads"
          >
            <Switch
              label="Toolbar default expanded"
              checked={settings.toolbarDefaultExpanded}
              onChange={(v) => onUpdateSetting('toolbarDefaultExpanded', v)}
            />
          </SettingsRow>
        </>
      ),
    },
    {
      id: 'terminal',
      title: 'Terminal',
      rows: (
        <>
          <TerminalFontRow
            value={settings.terminalFont}
            onSave={(v) => onUpdateSetting('terminalFont', v)}
          />
          <SettingsRow
            title="Disable right-click menu"
            desc="Block context menu on terminal area"
          >
            <Switch
              label="Disable right-click menu"
              checked={settings.disableContextMenu}
              onChange={(v) => onUpdateSetting('disableContextMenu', v)}
            />
          </SettingsRow>
          {driveSizeSupported && (
            <SettingsRow
              title="Fit herdr pane to this device"
              desc="Resizes the pane on the desktop too, until this page is hidden or closed, or another device takes over"
            >
              <Switch
                label="Fit herdr pane to this device"
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
      title: 'Sessions',
      rows: (
        <>
          <SettingsRow
            title="Show session tabs"
            desc="Display tab bar for quick session switching (desktop)"
          >
            <Switch
              label="Show session tabs"
              checked={settings.showSessionTabs}
              onChange={(v) => onUpdateSetting('showSessionTabs', v)}
            />
          </SettingsRow>
          <SettingsRow
            title="Session poll interval"
            desc={`How often to sync session list (${formatSeconds(settings.pollInterval)})`}
          >
            <select
              aria-label="Session poll interval"
              value={settings.pollInterval}
              onChange={(e) =>
                onUpdateSetting('pollInterval', Number(e.target.value))
              }
              className={`px-2 ${CONTROL} ${FOCUS_RING}`}
            >
              {POLL_INTERVAL_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {formatSeconds(v)}
                </option>
              ))}
            </select>
          </SettingsRow>
        </>
      ),
    },
  ]

  if (hasActions) {
    groups.push({
      id: 'data',
      title: 'Data & help',
      rows: (
        <div className="flex flex-col gap-1 px-4 py-2.5 ui-native:bg-surface-raised">
          {onShowGestureHints && (
            <Button variant="ghost" onClick={onShowGestureHints}>
              Show Gesture Hints
            </Button>
          )}
          {onCheckForUpdate && (
            <>
              <Button
                variant="ghost"
                disabled={updateChecking}
                onClick={async () => {
                  const msg = await onCheckForUpdate()
                  if (msg) {
                    setInlineToast(msg)
                    if (toastTimerRef.current)
                      clearTimeout(toastTimerRef.current)
                    toastTimerRef.current = setTimeout(
                      () => setInlineToast(null),
                      4000,
                    )
                  }
                }}
              >
                <RefreshCw
                  size={16}
                  aria-hidden="true"
                  className={updateChecking ? 'motion-safe:animate-spin' : ''}
                />
                {updateChecking ? 'Checking...' : 'Check for Updates'}
              </Button>
              {/* Stays mounted so a screen reader announces the message */}
              <p
                role="status"
                className="m-0 text-center text-[12px] text-fg-muted empty:hidden"
              >
                {inlineToast}
              </p>
            </>
          )}
          {onClearHistory && (
            <Button
              variant="danger"
              disabled={historyCount === 0}
              onClick={onClearHistory}
            >
              <Trash2 size={16} aria-hidden="true" />
              Clear Command History ({historyCount})
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
      title="Settings"
      // Full screen on a phone, a two-column dialog on desktop
      className="max-md:h-dvh max-md:max-h-dvh md:h-[34rem] md:max-w-3xl"
    >
      <div className="md:flex md:min-h-full">
        <nav
          aria-label="Settings groups"
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
