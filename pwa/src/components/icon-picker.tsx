import { useState } from 'react'
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
}

// The picker is a Sheet (a modal <dialog> in the top layer): opened from the
// sessions sheet, a fixed overlay would be clipped by that sheet's transform.
export function IconPicker({ value, onChange }: Props) {
  const [isOpen, setIsOpen] = useState(false)

  const handleSelect = (icon: string) => {
    onChange(icon)
    setIsOpen(false)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={`flex size-10 shrink-0 items-center justify-center rounded-control border border-border bg-surface text-xl transition-colors duration-(--duration-fast) hover:border-border-strong pointer-coarse:size-touch ${FOCUS_RING}`}
        title="Change icon"
      >
        {value}
      </button>

      <Sheet
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Choose Icon"
        closeLabel="Cancel"
        className="md:max-w-sm"
      >
        <div className="grid grid-cols-6 gap-2 p-4">
          {ICONS.map((icon) => (
            <button
              key={icon}
              type="button"
              aria-pressed={value === icon}
              onClick={() => handleSelect(icon)}
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
    </>
  )
}
