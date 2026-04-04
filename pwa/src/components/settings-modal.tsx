import { useEffect, useRef } from 'react'
import type {
  ImeSendBehavior,
  PasteSource,
  Settings,
} from '../hooks/use-settings'

interface Props {
  isOpen: boolean
  onClose: () => void
  settings: Settings
  onUpdateSetting: <K extends keyof Settings>(
    key: K,
    value: Settings[K],
  ) => void
  onShowGestureHints?: () => void
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: () => void
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {label}
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
          {description}
        </p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={`relative w-11 h-6 rounded-full transition-colors ${
          checked ? 'bg-blue-500' : 'bg-zinc-300 dark:bg-zinc-600'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
            checked ? 'translate-x-5' : ''
          }`}
        />
      </button>
    </div>
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

const PASTE_SOURCE_OPTIONS: {
  value: PasteSource
  label: string
  desc: string
}[] = [
  {
    value: 'clipboard',
    label: 'System clipboard',
    desc: 'Paste from device clipboard (Ctrl+Shift+V)',
  },
  {
    value: 'tmux',
    label: 'tmux buffer',
    desc: 'Paste from tmux copy mode buffer',
  },
]

export function SettingsModal({
  isOpen,
  onClose,
  settings,
  onUpdateSetting,
  onShowGestureHints,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (isOpen) {
      dialog.showModal()
      const handleCancel = (e: Event) => {
        e.preventDefault()
        onClose()
      }
      dialog.addEventListener('cancel', handleCancel)
      return () => dialog.removeEventListener('cancel', handleCancel)
    } else {
      dialog.close()
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-50 m-auto w-[90vw] max-w-md rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 p-0 backdrop:bg-black/50 shadow-xl"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-zinc-900 dark:text-white">
            Settings
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="space-y-5">
          <div>
            <p className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              Text input send behavior
            </p>
            <div className="space-y-2">
              {IME_SEND_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    settings.imeSendBehavior === opt.value
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-zinc-200 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="imeSendBehavior"
                    value={opt.value}
                    checked={settings.imeSendBehavior === opt.value}
                    onChange={() =>
                      onUpdateSetting('imeSendBehavior', opt.value)
                    }
                    className="mt-0.5 accent-blue-500"
                  />
                  <div>
                    <div className="text-sm font-medium text-zinc-900 dark:text-white">
                      {opt.label}
                    </div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {opt.desc}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div>
            <p className="block text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2">
              Paste button source
            </p>
            <div className="space-y-2">
              {PASTE_SOURCE_OPTIONS.map((opt) => (
                <label
                  key={opt.value}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    settings.pasteSource === opt.value
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-zinc-200 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700/50'
                  }`}
                >
                  <input
                    type="radio"
                    name="pasteSource"
                    value={opt.value}
                    checked={settings.pasteSource === opt.value}
                    onChange={() => onUpdateSetting('pasteSource', opt.value)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <div>
                    <div className="text-sm font-medium text-zinc-900 dark:text-white">
                      {opt.label}
                    </div>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      {opt.desc}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <ToggleRow
            label="Toolbar default expanded"
            description="Show all keys when toolbar loads"
            checked={settings.toolbarDefaultExpanded}
            onChange={() =>
              onUpdateSetting(
                'toolbarDefaultExpanded',
                !settings.toolbarDefaultExpanded,
              )
            }
          />

          <ToggleRow
            label="Disable right-click menu"
            description="Block context menu on terminal area"
            checked={settings.disableContextMenu}
            onChange={() =>
              onUpdateSetting(
                'disableContextMenu',
                !settings.disableContextMenu,
              )
            }
          />

          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Session poll interval
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                How often to sync session list (
                {formatSeconds(settings.pollInterval)})
              </p>
            </div>
            <select
              value={settings.pollInterval}
              onChange={(e) =>
                onUpdateSetting('pollInterval', Number(e.target.value))
              }
              className="rounded-lg border border-zinc-200 dark:border-zinc-600 bg-white dark:bg-zinc-700 text-sm text-zinc-900 dark:text-white px-2 py-1.5"
            >
              {POLL_INTERVAL_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {formatSeconds(v)}
                </option>
              ))}
            </select>
          </div>

          {onShowGestureHints && (
            <div className="pt-2 border-t border-zinc-200 dark:border-zinc-700">
              <button
                onClick={onShowGestureHints}
                className="w-full py-2.5 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
              >
                Show Gesture Hints
              </button>
            </div>
          )}
        </div>
      </div>
    </dialog>
  )
}
