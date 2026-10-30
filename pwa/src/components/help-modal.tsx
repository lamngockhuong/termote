import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
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
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { APP_INFO } from '../utils/app-info'
import { AgentStatusBadge } from './agent-status-badge'
import { FOCUS_RING } from './ui/button'
import { SegmentedControl } from './ui/segmented-control'
import { Sheet } from './ui/sheet'

interface Props {
  isOpen: boolean
  onClose: () => void
  // Backend has tmux copy mode and prefix keys; false hides the tmux help.
  copyModeSupported?: boolean
}

type TabId = 'gestures' | 'tmux' | 'toolbar'

// A key drawn as it is typed (a keycap, an icon), or named in words
type GuideKey = { key: ReactNode } | { keyLabel: MessageKey }

type GuideItem = GuideKey & {
  desc: MessageKey
  // Shown only when the backend has tmux copy mode (true) or lacks it (false)
  tmux?: boolean
}

interface GuideSection {
  title: MessageKey
  items: GuideItem[]
}

const ICON_SIZE = 14

const GESTURES_GUIDE: GuideSection[] = [
  {
    title: 'help.gestures.title',
    items: [
      {
        keyLabel: 'help.gestures.swipeLeft',
        desc: 'help.gestures.swipeLeftDesc',
      },
      {
        keyLabel: 'help.gestures.swipeRight',
        desc: 'help.gestures.swipeRightDesc',
      },
      {
        keyLabel: 'help.gestures.swipeUpDown',
        desc: 'help.gestures.swipeUpDownDesc',
      },
      {
        keyLabel: 'help.gestures.longPress',
        desc: 'help.gestures.longPressDesc',
      },
      { keyLabel: 'help.gestures.pinch', desc: 'help.gestures.pinchDesc' },
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

// Keycaps carry the keys' own names, the same in every language
const TOOLBAR_GUIDE: GuideSection[] = [
  {
    title: 'help.buttons.title',
    items: [
      { key: <Keyboard size={ICON_SIZE} />, desc: 'help.buttons.keyboard' },
      { key: <Languages size={ICON_SIZE} />, desc: 'help.buttons.ime' },
      { key: 'Esc', desc: 'help.buttons.esc' },
      { key: 'Ctrl', desc: 'help.buttons.ctrl' },
      { key: <UpDownIcon />, desc: 'help.buttons.upDown' },
      { key: <CornerDownLeft size={ICON_SIZE} />, desc: 'help.buttons.enter' },
      { key: 'Tab', desc: 'help.buttons.tab' },
      { key: <Ellipsis size={ICON_SIZE} />, desc: 'help.buttons.extra' },
    ],
  },
  {
    title: 'help.expanded.title',
    items: [
      { key: <Clock size={ICON_SIZE} />, desc: 'help.expanded.history' },
      {
        key: <Clipboard size={ICON_SIZE} />,
        desc: 'help.expanded.pasteSource',
        tmux: true,
      },
      {
        key: <Clipboard size={ICON_SIZE} />,
        desc: 'help.expanded.pasteSystem',
        tmux: false,
      },
      { key: <ImagePlus size={ICON_SIZE} />, desc: 'help.expanded.attach' },
      {
        key: <TextSelect size={ICON_SIZE} />,
        desc: 'help.expanded.selectText',
      },
      { key: 'Shift', desc: 'help.expanded.shift' },
      { key: '⇧Tab', desc: 'help.expanded.shiftTab' },
      { key: <LeftRightIcon />, desc: 'help.expanded.leftRight' },
      {
        key: <History size={ICON_SIZE} />,
        desc: 'help.expanded.copyMode',
        tmux: true,
      },
      { key: <ScrollIcon />, desc: 'help.expanded.page', tmux: true },
      { key: <ScrollIcon />, desc: 'help.expanded.scroll', tmux: false },
    ],
  },
  {
    title: 'help.ctrl.title',
    items: [
      { key: '^C', desc: 'help.ctrl.c' },
      { key: '^D', desc: 'help.ctrl.d' },
      { key: '^Z', desc: 'help.ctrl.z' },
      { key: '^L', desc: 'help.ctrl.l' },
      { key: '^A', desc: 'help.ctrl.a' },
      { key: '^E', desc: 'help.ctrl.e' },
      { key: '^B', desc: 'help.ctrl.prefix', tmux: true },
      { key: '^B', desc: 'help.ctrl.back', tmux: false },
    ],
  },
  {
    title: 'help.ctrlShift.title',
    items: [
      { key: '^⇧C', desc: 'help.ctrlShift.c' },
      { key: '^⇧V', desc: 'help.ctrlShift.v' },
      { key: '^⇧Z', desc: 'help.ctrlShift.z' },
      { key: '^⇧X', desc: 'help.ctrlShift.x' },
    ],
  },
  {
    // Each row by the name the toolbar shows on it
    title: 'help.rows.title',
    items: [
      { keyLabel: 'shell.keys.actions', desc: 'help.rows.actions' },
      {
        keyLabel: 'shell.keys.textScroll',
        desc: 'help.rows.textCopyMode',
        tmux: true,
      },
      {
        keyLabel: 'shell.keys.textScroll',
        desc: 'help.rows.textScroll',
        tmux: false,
      },
      { keyLabel: 'shell.keys.navigate', desc: 'help.rows.navigate' },
      { key: 'Ctrl +', desc: 'help.rows.ctrl' },
    ],
  },
  {
    title: 'help.status.title',
    items: [
      {
        key: <AgentStatusBadge status="blocked" />,
        desc: 'help.status.blocked',
      },
      {
        key: <AgentStatusBadge status="working" />,
        desc: 'tasks.status.working',
      },
      { key: <AgentStatusBadge status="done" />, desc: 'tasks.status.done' },
      { key: <AgentStatusBadge status="idle" />, desc: 'tasks.status.idle' },
      { keyLabel: 'common.chat', desc: 'help.status.chat' },
    ],
  },
]

// tmux's own keys, typed after the prefix
const TMUX_GUIDE: GuideSection[] = [
  {
    title: 'help.windows.title',
    items: [
      { key: 'c', desc: 'help.windows.create' },
      { key: 'n / p', desc: 'help.windows.nextPrev' },
      { key: '0-9', desc: 'help.windows.switch' },
      { key: ',', desc: 'help.windows.rename' },
      { key: '&', desc: 'help.windows.kill' },
      { key: 'w', desc: 'help.windows.list' },
    ],
  },
  {
    title: 'help.panes.title',
    items: [
      { key: '%', desc: 'help.panes.splitVertical' },
      { key: '"', desc: 'help.panes.splitHorizontal' },
      { key: '← ↑ → ↓', desc: 'help.panes.navigate' },
      { key: 'x', desc: 'help.panes.kill' },
      { key: 'z', desc: 'help.panes.zoom' },
      { key: 'Space', desc: 'help.panes.layouts' },
    ],
  },
  {
    title: 'help.copy.title',
    items: [
      { key: '[', desc: 'help.copy.enter' },
      { key: 'q', desc: 'help.copy.exit' },
      { key: 'Space', desc: 'help.copy.start' },
      { key: 'Enter', desc: 'help.copy.copy' },
      { key: ']', desc: 'help.copy.paste' },
      { key: '/', desc: 'help.copy.search' },
    ],
  },
  {
    title: 'help.sessions.title',
    items: [
      { key: 's', desc: 'help.sessions.list' },
      { key: '$', desc: 'help.sessions.rename' },
      { key: 'd', desc: 'help.sessions.detach' },
      { key: '( / )', desc: 'help.sessions.prevNext' },
    ],
  },
]

const TABS: { id: TabId; labelKey: MessageKey }[] = [
  { id: 'gestures', labelKey: 'help.tab.gestures' },
  { id: 'toolbar', labelKey: 'help.tab.toolbar' },
  { id: 'tmux', labelKey: 'help.tab.tmux' },
]

export function HelpModal({
  isOpen,
  onClose,
  copyModeSupported = true,
}: Props) {
  const { t } = useT()
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
    <Sheet isOpen={isOpen} onClose={onClose} title={t('help.title')}>
      <div className="space-y-4 p-4">
        <SegmentedControl
          label={t('help.topic')}
          options={tabs.map((tab) => ({
            value: tab.id,
            content: t(tab.labelKey),
          }))}
          value={shownTab}
          onChange={setActiveTab}
        />
        {getGuide().map((section) => (
          <section key={section.title}>
            <h3 className="m-0 mb-2 font-label text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
              {t(section.title)}
            </h3>
            <div className="divide-y divide-border overflow-hidden rounded-panel border border-border ui-native:border-0 ui-native:bg-surface-raised">
              {section.items.map((item) => (
                <div
                  key={item.desc}
                  className="flex items-center gap-3 px-3 py-2"
                >
                  <code className="min-w-[5rem] rounded-control bg-surface px-2 py-1 font-label text-xs text-fg ui-native:bg-bg">
                    {'keyLabel' in item ? t(item.keyLabel) : item.key}
                  </code>
                  <span className="text-sm text-fg-muted">{t(item.desc)}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
        <a
          href={APP_INFO.links.usageDocs}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex items-center gap-1 rounded-control text-sm text-fg-muted hover:text-fg ${FOCUS_RING}`}
        >
          {t('help.docs')}
          <ArrowUpRight size={ICON_SIZE} aria-hidden="true" />
          <span className="sr-only"> {t('settings.newTab')}</span>
        </a>
      </div>
    </Sheet>
  )
}
