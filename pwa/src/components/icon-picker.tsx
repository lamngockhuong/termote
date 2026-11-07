import { useState } from 'react'
import { useT } from '../i18n/i18n-context'
import { FOCUS_RING } from './ui/button'
import { Sheet } from './ui/sheet'

const ICONS = [
  '💻',
  '🤖',
  '🐙',
  '📺',
  '🔧',
  '🚀',
  '⚡',
  '🎯',
  '📁',
  '🌐',
  '🔒',
  '📊',
  '🎨',
  '🔥',
  '💡',
  '🎮',
  '📝',
  '🛠️',
]

interface Props {
  value: string
  onChange: (icon: string) => void
  // The Automatic choice (no icon picked: the agent's logo while one runs),
  // pressed while auto
  auto?: boolean
  onAuto?: () => void
}

// The picker is a Sheet (a modal <dialog> in the top layer): opened from the
// sessions sheet, a fixed overlay would be clipped by that sheet's transform.
export function IconPicker({ value, onChange, auto, onAuto }: Props) {
  const { t } = useT()
  const [isOpen, setIsOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={`flex size-10 shrink-0 items-center justify-center rounded-control border border-border bg-surface text-xl transition-colors duration-(--duration-fast) hover:border-border-strong pointer-coarse:size-touch ${FOCUS_RING}`}
        title={t('shell.icon.change')}
      >
        {value}
      </button>
      <IconSheet
        isOpen={isOpen}
        value={auto ? '' : value}
        onClose={() => setIsOpen(false)}
        onSelect={(icon) => {
          onChange(icon)
          setIsOpen(false)
        }}
        auto={auto}
        onAuto={
          onAuto &&
          (() => {
            onAuto()
            setIsOpen(false)
          })
        }
      />
    </>
  )
}

// The icons to choose from, on their own: a tab's menu opens them with no
// form around them
export function IconSheet({
  isOpen,
  value,
  onClose,
  onSelect,
  auto,
  onAuto,
}: {
  isOpen: boolean
  value: string
  onClose: () => void
  onSelect: (icon: string) => void
  auto?: boolean
  // Unset: no Automatic choice
  onAuto?: () => void
}) {
  const { t } = useT()
  return (
    <Sheet
      isOpen={isOpen}
      onClose={onClose}
      title={t('shell.icon.choose')}
      closeLabel={t('common.cancel')}
      className="md:max-w-sm"
    >
      {onAuto && (
        <div className="px-4 pt-4">
          <button
            type="button"
            aria-pressed={!!auto}
            onClick={onAuto}
            className={`flex w-full flex-col items-start rounded-control px-3 py-2 text-left transition-colors duration-(--duration-fast) ${FOCUS_RING} ${
              auto
                ? 'bg-accent-soft ring-2 ring-accent'
                : 'bg-surface hover:bg-surface-raised'
            }`}
          >
            <span className="text-sm font-medium text-fg">
              {t('shell.icon.auto')}
            </span>
            <span className="text-xs text-fg-muted">
              {t('shell.icon.autoHint')}
            </span>
          </button>
        </div>
      )}
      <div className="grid grid-cols-6 gap-2 p-4">
        {ICONS.map((icon) => (
          <button
            key={icon}
            type="button"
            aria-pressed={value === icon}
            onClick={() => onSelect(icon)}
            className={`flex aspect-square items-center justify-center rounded-control text-xl transition-colors duration-(--duration-fast) ${FOCUS_RING} ${
              value === icon
                ? 'bg-accent-soft ring-2 ring-accent'
                : 'bg-surface hover:bg-surface-raised'
            }`}
          >
            {icon}
          </button>
        ))}
      </div>
    </Sheet>
  )
}
