import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '../contexts/theme-context'
import { SegmentedControl } from './ui/segmented-control'

type Theme = 'light' | 'dark' | 'system'

const OPTIONS = [
  { value: 'light', Icon: Sun, label: 'Light' },
  { value: 'dark', Icon: Moon, label: 'Dark' },
  { value: 'system', Icon: Monitor, label: 'System' },
] as const

// Theme choice as a segmented row, for places outside the overflow menu
// (the menu uses MenuItemRadio, since a menu may only hold menu items).
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <SegmentedControl<Theme>
      label="Theme"
      value={theme}
      onChange={setTheme}
      options={OPTIONS.map(({ value, Icon, label }) => ({
        value,
        label: `${label} theme`,
        content: <Icon size={15} aria-hidden="true" />,
      }))}
    />
  )
}
