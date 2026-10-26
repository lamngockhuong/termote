import {
  AppWindow,
  ArrowUpCircle,
  Info,
  LifeBuoy,
  Link,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  RotateCcw,
  Settings,
  Sun,
} from 'lucide-react'
import { useState } from 'react'
import { useTheme } from '../contexts/theme-context'
import { logout } from '../hooks/use-mux-api'
import { signedOut } from '../utils/files-persist'
import type { OpenWindowEvent } from '../utils/open-window'
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
  // Opens it in a window of its own (desktop; Shift: a popup)
  onOpenWindow?: (e: OpenWindowEvent) => void
  // Ends the session (only when the server has sign-in on)
  onLogout?: () => void
  // A newer release than the server runs: a dot on the trigger and an item
  // that calls onOpenUpdates (Settings at Updates)
  updateVersion?: string | null
  onOpenUpdates?: () => void
}

const THEMES = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const

// Each step runs whatever the one before did: a browser that refuses the
// service worker or cache API still signs out.
async function clearCacheAndReload() {
  // Signs out as logging out does: the drafts and tabs kept on this device
  // go too.
  signedOut()
  if ('serviceWorker' in navigator) {
    await navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((r) => r.unregister())),
      )
      .catch(() => undefined)
  }
  if ('caches' in window) {
    await caches
      .keys()
      .then((names) => Promise.all(names.map((name) => caches.delete(name))))
      .catch(() => undefined)
  }
  // End the session on the server: the cookie is HttpOnly, so the page
  // cannot clear it itself. Without sign-in there is none to end.
  await logout().catch(() => false)
  window.location.reload()
}

// The header's overflow menu: font size (mobile), theme, and the dialogs.
export function SettingsMenu({
  onOpenAbout,
  onOpenHelp,
  onOpenSettings,
  fontSize,
  onCopyLink,
  onOpenWindow,
  onLogout,
  updateVersion,
  onOpenUpdates,
}: Props) {
  const update = updateVersion && onOpenUpdates
  const { theme, setTheme } = useTheme()
  const [clearing, setClearing] = useState(false)

  const handleClearCache = async () => {
    setClearing(true)
    await clearCacheAndReload()
  }

  return (
    <Menu
      label={update ? `More, v${updateVersion} available` : 'More'}
      trigger={
        <span className="relative inline-flex">
          <MoreHorizontal size={20} aria-hidden="true" />
          {update && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-accent"
            />
          )}
        </span>
      }
    >
      {update && (
        <>
          <MenuItem
            icon={<ArrowUpCircle size={17} className="text-accent" />}
            onSelect={onOpenUpdates}
          >
            Update to v{updateVersion}
          </MenuItem>
          <MenuSeparator />
        </>
      )}
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
      {onOpenWindow && (
        <MenuItem
          icon={<AppWindow size={17} />}
          onSelect={onOpenWindow}
          title="Shift: a popup"
        >
          Open in new window
        </MenuItem>
      )}
      {onLogout && (
        <MenuItem icon={<LogOut size={17} />} onSelect={onLogout}>
          Log out
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
