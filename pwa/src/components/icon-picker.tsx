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
]

interface Props {
  value: string
  onChange: (icon: string) => void
}

export function IconPicker({ value, onChange }: Props) {
  return (
    <div className="grid grid-cols-6 gap-1 p-2">
      {ICONS.map((icon) => (
        <button
          key={icon}
          type="button"
          onClick={() => onChange(icon)}
          className={`w-10 h-10 text-xl rounded-lg transition-colors ${
            value === icon
              ? 'bg-blue-600'
              : 'bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600'
          }`}
        >
          {icon}
        </button>
      ))}
    </div>
  )
}
