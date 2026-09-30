import {
  Info,
  LifeBuoy,
  Link,
  Monitor,
  Moon,
  MoreHorizontal,
  RotateCcw,
  Settings,
  Sun,
} from 'lucide-react'
import { useState } from 'react'
import { useTheme } from '../contexts/theme-context'
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuItemRadio,
  MenuSeparator,
} from './ui/menu'

interface FontSizeControls {
  value: number
  onDecrease: () => void
  onIncrease: () => void
}

interface Props {
  onOpenAbout: () => void
  onOpenHelp: () => void
  onOpenSettings: () => void
  // Font size in the menu (mobile: the header has no room for the buttons)
  fontSize?: FontSizeControls
  // Copies a link to the session on screen
  onCopyLink?: () => void
}

const THEMES = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const

async function clearCacheAndReload() {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((r) => r.unregister()))
    }
    if ('caches' in window) {
      const cacheNames = await caches.keys()
      await Promise.all(cacheNames.map((name) => caches.delete(name)))
    }
    // Clear session cookie to trigger basic auth on reload
    // biome-ignore lint/suspicious/noDocumentCookie: needed to clear auth session before reload
    document.cookie = 'termote_session=; Max-Age=0; path=/'
  } finally {
    window.location.reload()
  }
}

// The header's overflow menu: font size (mobile), theme, and the dialogs.
export function SettingsMenu({
  onOpenAbout,
  onOpenHelp,
  onOpenSettings,
  fontSize,
  onCopyLink,
}: Props) {
  const { theme, setTheme } = useTheme()
  const [clearing, setClearing] = useState(false)

  const handleClearCache = async () => {
    setClearing(true)
    await clearCacheAndReload()
  }

  return (
    <Menu
      label="More"
      trigger={<MoreHorizontal size={20} aria-hidden="true" />}
    >
      {fontSize && (
        <>
          <MenuGroup label={`Font size · ${fontSize.value}`}>
            <MenuItem
              icon={<span className="inline-block w-5 text-center">A−</span>}
              onSelect={fontSize.onDecrease}
              keepOpen
            >
              Decrease font size
            </MenuItem>
            <MenuItem
              icon={<span className="inline-block w-5 text-center">A+</span>}
              onSelect={fontSize.onIncrease}
              keepOpen
            >
              Increase font size
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
        </>
      )}
      <MenuGroup label="Theme">
        {THEMES.map(({ value, label, Icon }) => (
          <MenuItemRadio
            key={value}
            checked={theme === value}
            icon={<Icon size={17} />}
            onSelect={() => setTheme(value)}
            keepOpen
          >
            {label}
          </MenuItemRadio>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem icon={<Settings size={17} />} onSelect={onOpenSettings}>
        Settings
      </MenuItem>
      <MenuItem icon={<LifeBuoy size={17} />} onSelect={onOpenHelp}>
        Help &amp; gestures
      </MenuItem>
      <MenuItem icon={<Info size={17} />} onSelect={onOpenAbout}>
        About
      </MenuItem>
      {onCopyLink && (
        <MenuItem icon={<Link size={17} />} onSelect={onCopyLink}>
          Copy link
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        icon={<RotateCcw size={17} />}
        onSelect={handleClearCache}
        disabled={clearing}
        keepOpen
        danger
      >
        {clearing ? 'Clearing...' : 'Clear cache & reload'}
      </MenuItem>
    </Menu>
  )
}
