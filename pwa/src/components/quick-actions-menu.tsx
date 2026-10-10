import {
  Ban,
  Eraser,
  ImagePlus,
  LogOut,
  Sparkles,
  TextSelect,
} from 'lucide-react'
import { useHaptic } from '../hooks/use-haptic'
import { FOCUS_RING } from './ui/button'
import { Sheet } from './ui/sheet'

interface Action {
  icon: React.ReactNode
  label: string
  key: string
  ctrl?: boolean
  text?: string // For sending text like "clear"
}

const ICON_SIZE = 18

const ACTIONS: Action[] = [
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
  // Adds an Attach image item (the server takes uploads)
  onAttachImage?: () => void
  // Adds a Select text item (the pane's text to select and copy)
  onSelectText?: () => void
}

function runAction(
  action: Action,
  { onSendKey, onSendText }: QuickActionHandlers,
) {
  if (action.text) {
    onSendText(action.text)
    onSendKey('Enter')
  } else {
    onSendKey(action.key, { ctrl: action.ctrl })
  }
}

// Common actions in a sheet, opened by the toolbar's Quick actions key.
const ITEM_CLASS = `flex h-12 w-full items-center gap-3 px-4 text-left text-[15px] text-fg hover:bg-surface ui-terminal:font-label ui-terminal:text-[13px] ${FOCUS_RING} focus-visible:-outline-offset-2`

export function QuickActionsSheet({
  isOpen,
  onClose,
  onSendKey,
  onSendText,
  onAttachImage,
  onSelectText,
}: QuickActionHandlers & { isOpen: boolean; onClose: () => void }) {
  const { trigger: haptic } = useHaptic()
  return (
    <Sheet isOpen={isOpen} onClose={onClose} title="Quick actions">
      <div className="py-1">
        {ACTIONS.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={() => {
              haptic('medium')
              runAction(action, { onSendKey, onSendText })
              onClose()
            }}
            className={ITEM_CLASS}
          >
            <span aria-hidden="true" className="text-fg-muted">
              {action.icon}
            </span>
            {action.label}
          </button>
        ))}
        {onAttachImage && (
          <button
            type="button"
            onClick={() => {
              haptic('medium')
              onClose()
              onAttachImage()
            }}
            className={ITEM_CLASS}
          >
            <span aria-hidden="true" className="text-fg-muted">
              <ImagePlus size={ICON_SIZE} />
            </span>
            Attach image
          </button>
        )}
        {onSelectText && (
          <button
            type="button"
            onClick={() => {
              haptic('medium')
              onClose()
              onSelectText()
            }}
            className={ITEM_CLASS}
          >
            <span aria-hidden="true" className="text-fg-muted">
              <TextSelect size={ICON_SIZE} />
            </span>
            Select text
          </button>
        )}
      </div>
    </Sheet>
  )
}
