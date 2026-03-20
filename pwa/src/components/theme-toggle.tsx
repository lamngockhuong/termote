import { useTheme } from '../contexts/theme-context'

const OPTIONS = [
  { value: 'light', icon: '☀️', label: 'Light' },
  { value: 'dark', icon: '🌙', label: 'Dark' },
  { value: 'system', icon: '💻', label: 'System' },
] as const

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="flex gap-1">
      {OPTIONS.map(({ value, icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={`p-2 rounded-lg transition-colors ${
            theme === value
              ? 'bg-blue-600 text-white'
              : 'bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600'
          }`}
          title={label}
          aria-label={`${label} theme`}
          aria-pressed={theme === value}
        >
          {icon}
        </button>
      ))}
    </div>
  )
}
