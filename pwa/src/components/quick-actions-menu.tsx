import { Ban, Eraser, LogOut, Sparkles } from 'lucide-react'
import type { MessageKey } from '../i18n/messages/en'

export interface QuickAction {
  // The action's name in English, for its data-key
  id: string
  icon: React.ReactNode
  label: MessageKey
  key: string
  ctrl?: boolean
  text?: string // For sending text like "clear"
}

const ICON_SIZE = 18

// Common actions, shown as the Actions row of the expanded toolbar (mobile)
export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'Clear',
    icon: <Eraser size={ICON_SIZE} />,
    label: 'shell.action.clear',
    text: 'clear',
    key: 'Enter',
  },
  {
    id: 'Cancel',
    icon: <Ban size={ICON_SIZE} />,
    label: 'shell.action.cancel',
    key: 'c',
    ctrl: true,
  },
  {
    id: 'Clear line',
    icon: <Sparkles size={ICON_SIZE} />,
    label: 'shell.action.clearLine',
    key: 'u',
    ctrl: true,
  },
  {
    id: 'Exit',
    icon: <LogOut size={ICON_SIZE} />,
    label: 'shell.action.exit',
    key: 'd',
    ctrl: true,
  },
]

export interface QuickActionHandlers {
  onSendKey: (key: string, opts?: { ctrl?: boolean }) => void
  onSendText: (text: string) => void
}

export function runAction(
  action: QuickAction,
  { onSendKey, onSendText }: QuickActionHandlers,
) {
  if (action.text) {
    onSendText(action.text)
    onSendKey('Enter')
  } else {
    onSendKey(action.key, { ctrl: action.ctrl })
  }
}
