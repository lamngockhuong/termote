import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronsDown,
  ChevronsUp,
  Clipboard,
  Clock,
  CornerDownLeft,
  Ellipsis,
  History,
  ImagePlus,
  Keyboard,
  Languages,
  TextSelect,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { AgentStatusBadge } from './agent-status-badge'
import { SegmentedControl } from './ui/segmented-control'
import { Sheet } from './ui/sheet'

interface Props {
  isOpen: boolean
  onClose: () => void
  // Backend has tmux copy mode and prefix keys; false hides the tmux help.
  copyModeSupported?: boolean
}

type TabId = 'gestures' | 'tmux' | 'toolbar'

interface GuideItem {
  key: ReactNode
  desc: string
  // Shown only when the backend has tmux copy mode (true) or lacks it (false)
  tmux?: boolean
}

interface GuideSection {
  title: string
  items: GuideItem[]
}

const ICON_SIZE = 14

const GESTURES_GUIDE: GuideSection[] = [
  {
    title: 'Touch Gestures',
    items: [
      { key: 'Swipe Left', desc: 'Cancel (Ctrl+C)' },
      { key: 'Swipe Right', desc: 'Tab completion' },
      { key: 'Swipe Up/Down', desc: 'Scroll history' },
      { key: 'Long Press', desc: 'Paste from clipboard' },
      { key: 'Pinch In/Out', desc: 'Decrease/Increase font size' },
    ],
  },
]

const UpDownIcon = () => (
  <span className="inline-flex items-center gap-0.5">
    <ArrowUp size={ICON_SIZE} />
    <ArrowDown size={ICON_SIZE} />
  </span>
)

const LeftRightIcon = () => (
  <span className="inline-flex items-center gap-0.5">
    <ArrowLeft size={ICON_SIZE} />
    <ArrowRight size={ICON_SIZE} />
  </span>
)

const ScrollIcon = () => (
  <span className="inline-flex items-center gap-0.5">
    <ChevronsUp size={ICON_SIZE} />
    <ChevronsDown size={ICON_SIZE} />
  </span>
)

const TOOLBAR_GUIDE: GuideSection[] = [
  {
    title: 'Toolbar Buttons',
    items: [
      { key: <Keyboard size={ICON_SIZE} />, desc: 'Toggle virtual keyboard' },
      { key: <Languages size={ICON_SIZE} />, desc: 'Text input mode (IME)' },
      { key: 'Esc', desc: 'Escape key (clears modifiers if active)' },
      { key: 'Ctrl', desc: 'Toggle Ctrl modifier (sticky)' },
      { key: <UpDownIcon />, desc: 'Up/Down arrows' },
      {
        key: <CornerDownLeft size={ICON_SIZE} />,
        desc: 'Enter / Submit command',
      },
      { key: 'Tab', desc: 'Tab key / autocomplete' },
      {
        key: <Ellipsis size={ICON_SIZE} />,
        desc: 'Extra keys: show or hide the expanded rows (pinned at the right)',
      },
    ],
  },
  {
    title: 'Expanded Keys',
    items: [
      { key: <Clock size={ICON_SIZE} />, desc: 'Command history search' },
      {
        key: <Clipboard size={ICON_SIZE} />,
        desc: 'Paste (source configurable in Settings)',
        tmux: true,
      },
      {
        key: <Clipboard size={ICON_SIZE} />,
        desc: 'Paste from the system clipboard',
        tmux: false,
      },
      { key: <ImagePlus size={ICON_SIZE} />, desc: 'Attach an image' },
      {
        key: <TextSelect size={ICON_SIZE} />,
        desc: "Select text: the pane's text, to select and copy",
      },
      { key: 'Shift', desc: 'Toggle Shift modifier (sticky)' },
      { key: '⇧Tab', desc: 'Shift+Tab (e.g. switch mode in Claude Code)' },
      { key: <LeftRightIcon />, desc: 'Left/Right arrows' },
      {
        key: <History size={ICON_SIZE} />,
        desc: 'Toggle tmux copy mode',
        tmux: true,
      },
      { key: <ScrollIcon />, desc: 'Page up/down in copy mode', tmux: true },
      { key: <ScrollIcon />, desc: 'Scroll history', tmux: false },
    ],
  },
  {
    title: 'Ctrl Combos (when Ctrl active)',
    items: [
      { key: '^C', desc: 'Cancel/interrupt' },
      { key: '^D', desc: 'Exit/EOF' },
      { key: '^Z', desc: 'Suspend process' },
      { key: '^L', desc: 'Clear screen' },
      { key: '^A', desc: 'Move to line start' },
      { key: '^E', desc: 'Move to line end' },
      { key: '^B', desc: 'tmux prefix', tmux: true },
      { key: '^B', desc: 'Move cursor back', tmux: false },
    ],
  },
  {
    title: 'Ctrl+Shift Combos',
    items: [
      { key: '^⇧C', desc: 'Copy the selection, else send ^⇧C' },
      { key: '^⇧V', desc: 'Paste from clipboard' },
      { key: '^⇧Z', desc: 'Redo' },
      { key: '^⇧X', desc: 'Cut' },
    ],
  },
  {
    title: 'Expanded Toolbar Rows',
    items: [
      { key: 'Actions', desc: 'Clear, Cancel, Clear line, Exit (mobile)' },
      {
        key: 'Text · Scroll',
        desc: 'History, paste, attach image, select text, copy mode, page up/down',
        tmux: true,
      },
      {
        key: 'Text · Scroll',
        desc: 'History, paste, attach image, select text, scroll up/down',
        tmux: false,
      },
      {
        key: 'Navigate',
        desc: 'Shift, Shift+Tab, Left/Right, Home/End, PgUp/PgDn, Del/Bksp, Insert',
      },
      {
        key: 'Ctrl +',
        desc: 'Every Ctrl combo, above the toolbar while Ctrl is on',
      },
    ],
  },
  {
    title: 'Agent Status',
    items: [
      {
        key: <AgentStatusBadge status="blocked" />,
        desc: 'Blocked: the agent is waiting for you',
      },
      { key: <AgentStatusBadge status="working" />, desc: 'Working' },
      { key: <AgentStatusBadge status="done" />, desc: 'Done' },
      { key: <AgentStatusBadge status="idle" />, desc: 'Idle' },
      {
        key: 'Chat',
        desc: 'Claude Code and Codex panes: read the conversation, send a message, answer its dialogs (Codex on tmux: in the terminal)',
      },
    ],
  },
]

const TMUX_GUIDE: GuideSection[] = [
  {
    title: 'Windows (Ctrl+B, then...)',
    items: [
      { key: 'c', desc: 'Create new window' },
      { key: 'n / p', desc: 'Next / Previous window' },
      { key: '0-9', desc: 'Switch to window N' },
      { key: ',', desc: 'Rename current window' },
      { key: '&', desc: 'Kill current window' },
      { key: 'w', desc: 'List all windows' },
    ],
  },
  {
    title: 'Panes (Ctrl+B, then...)',
    items: [
      { key: '%', desc: 'Split vertically' },
      { key: '"', desc: 'Split horizontally' },
      { key: '← ↑ → ↓', desc: 'Navigate panes' },
      { key: 'x', desc: 'Kill current pane' },
      { key: 'z', desc: 'Toggle pane zoom' },
      { key: 'Space', desc: 'Cycle layouts' },
    ],
  },
  {
    title: 'Copy Mode (Ctrl+B, then...)',
    items: [
      { key: '[', desc: 'Enter copy mode' },
      { key: 'q', desc: 'Exit copy mode' },
      { key: 'Space', desc: 'Start selection' },
      { key: 'Enter', desc: 'Copy selection' },
      { key: ']', desc: 'Paste buffer' },
      { key: '/', desc: 'Search forward' },
    ],
  },
  {
    title: 'Sessions (Ctrl+B, then...)',
    items: [
      { key: 's', desc: 'List sessions' },
      { key: '$', desc: 'Rename session' },
      { key: 'd', desc: 'Detach from session' },
      { key: '( / )', desc: 'Prev / Next session' },
    ],
  },
]

const TABS: { id: TabId; label: string }[] = [
  { id: 'gestures', label: 'Gestures' },
  { id: 'toolbar', label: 'Toolbar' },
  { id: 'tmux', label: 'tmux' },
]

export function HelpModal({
  isOpen,
  onClose,
  copyModeSupported = true,
}: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('gestures')
  const tabs = copyModeSupported
    ? TABS
    : TABS.filter((tab) => tab.id !== 'tmux')
  // The tmux tab disappears when the backend has no copy mode
  const shownTab =
    !copyModeSupported && activeTab === 'tmux' ? 'gestures' : activeTab

  const getGuide = (): GuideSection[] => {
    switch (shownTab) {
      case 'gestures':
        return GESTURES_GUIDE
      case 'toolbar':
        return TOOLBAR_GUIDE.map((section) => ({
          ...section,
          items: section.items.filter(
            (item) =>
              item.tmux === undefined || item.tmux === copyModeSupported,
          ),
        }))
      case 'tmux':
        return TMUX_GUIDE
    }
  }

  return (
    <Sheet isOpen={isOpen} onClose={onClose} title="Usage Guide">
      <div className="space-y-4 p-4">
        <SegmentedControl
          label="Guide topic"
          options={tabs.map((tab) => ({
            value: tab.id,
            content: tab.label,
          }))}
          value={shownTab}
          onChange={setActiveTab}
        />
        {getGuide().map((section) => (
          <section key={section.title}>
            <h3 className="m-0 mb-2 font-label text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
              {section.title}
            </h3>
            <div className="divide-y divide-border overflow-hidden rounded-panel border border-border ui-native:border-0 ui-native:bg-surface-raised">
              {section.items.map((item) => (
                <div
                  key={item.desc}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <code className="min-w-[5rem] rounded-control bg-surface px-2 py-1 font-label text-xs text-fg ui-native:bg-bg">
                    {item.key}
                  </code>
                  <span className="text-sm text-fg-muted">{item.desc}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Sheet>
  )
}
