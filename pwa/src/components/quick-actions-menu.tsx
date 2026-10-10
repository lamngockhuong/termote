import { Ban, Eraser, LogOut, Sparkles } from 'lucide-react'

export interface QuickAction {
  icon: React.ReactNode
  label: string
  key: string
  ctrl?: boolean
  text?: string // For sending text like "clear"
}

const ICON_SIZE = 18

// Common actions, shown as the Actions row of the expanded toolbar (mobile)
export const QUICK_ACTIONS: QuickAction[] = [
  {
    icon: <Eraser size={ICON_SIZE} />,
    label: 'Clear',
    text: 'clear',
    key: 'Enter',
  },
  { icon: <Ban size={ICON_SIZE} />, label: 'Cancel', key: 'c', ctrl: true },
  {
    icon: <Sparkles size={ICON_SIZE} />,
    label: 'Clear line',
    key: 'u',
    ctrl: true,
  },
  { icon: <LogOut size={ICON_SIZE} />, label: 'Exit', key: 'd', ctrl: true },
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
