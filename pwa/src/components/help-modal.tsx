import { useEffect, useRef, useState } from 'react'

interface Props {
  isOpen: boolean
  onClose: () => void
}

type TabId = 'gestures' | 'tmux' | 'toolbar'

interface GuideSection {
  title: string
  items: { key: string; desc: string }[]
}

const GESTURES_GUIDE: GuideSection[] = [
  {
    title: 'Touch Gestures',
    items: [
      { key: 'Swipe Left', desc: 'Cancel (Ctrl+C)' },
      { key: 'Swipe Right', desc: 'Tab completion' },
      { key: 'Swipe Up/Down', desc: 'Scroll in copy mode' },
      { key: 'Long Press', desc: 'Paste from clipboard' },
      { key: 'Pinch In/Out', desc: 'Decrease/Increase font size' },
    ],
  },
]

const TOOLBAR_GUIDE: GuideSection[] = [
  {
    title: 'Toolbar Buttons',
    items: [
      { key: '⛶/⊟', desc: 'Expand/collapse keyboard' },
      { key: '⌨️ Keyboard', desc: 'Toggle virtual keyboard' },
      { key: 'Tab', desc: 'Tab key / autocomplete' },
      { key: 'Esc', desc: 'Escape key' },
      { key: '↵ Enter', desc: 'Submit command' },
      { key: 'Ctrl', desc: 'Toggle Ctrl modifier (sticky)' },
      { key: 'Shift', desc: 'Toggle Shift modifier (sticky)' },
      { key: '↑↓←→', desc: 'Arrow keys' },
      { key: '⏱ History', desc: 'Toggle tmux copy mode' },
      { key: '⇈⇊ Scroll', desc: 'Page up/down in copy mode' },
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
      { key: '^B', desc: 'tmux prefix (expanded mode)' },
    ],
  },
  {
    title: 'Ctrl+Shift Combos',
    items: [
      { key: '^⇧V', desc: 'Paste from clipboard' },
      { key: '^⇧C', desc: 'Copy (terminal)' },
      { key: '^⇧Z', desc: 'Redo' },
    ],
  },
  {
    title: 'Expanded Mode Keys',
    items: [
      { key: 'Home/End', desc: 'Jump to line start/end' },
      { key: 'Del/Bksp', desc: 'Delete forward/backward' },
      { key: 'PgUp/PgDn', desc: 'Page up/down' },
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

export function HelpModal({ isOpen, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [activeTab, setActiveTab] = useState<TabId>('gestures')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (isOpen) {
      dialog.showModal()
    } else {
      dialog.close()
    }
  }, [isOpen])

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose()
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [onClose, isOpen])

  if (!isOpen) return null

  const getGuide = (): GuideSection[] => {
    switch (activeTab) {
      case 'gestures':
        return GESTURES_GUIDE
      case 'toolbar':
        return TOOLBAR_GUIDE
      case 'tmux':
        return TMUX_GUIDE
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-50 m-auto w-[90vw] max-w-lg rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 p-0 backdrop:bg-black/50 shadow-xl"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="p-4 sm:p-6 max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-zinc-900 dark:text-white">
            Usage Guide
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-4 bg-zinc-100 dark:bg-zinc-700/50 p-1 rounded-lg">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                activeTab === tab.id
                  ? 'bg-white dark:bg-zinc-600 text-zinc-900 dark:text-white shadow-sm'
                  : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="overflow-y-auto flex-1 -mx-4 sm:-mx-6 px-4 sm:px-6">
          <div className="space-y-4">
            {getGuide().map((section) => (
              <div key={section.title}>
                <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
                  {section.title}
                </h3>
                <div className="bg-zinc-50 dark:bg-zinc-700/30 rounded-lg overflow-hidden">
                  {section.items.map((item, idx) => (
                    <div
                      key={item.key}
                      className={`flex items-center gap-3 px-3 py-2 ${
                        idx > 0
                          ? 'border-t border-zinc-200/50 dark:border-zinc-600/50'
                          : ''
                      }`}
                    >
                      <code className="min-w-[5rem] text-xs font-mono bg-zinc-200/70 dark:bg-zinc-600/70 px-2 py-1 rounded text-zinc-800 dark:text-zinc-200">
                        {item.key}
                      </code>
                      <span className="text-sm text-zinc-600 dark:text-zinc-400">
                        {item.desc}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </dialog>
  )
}
