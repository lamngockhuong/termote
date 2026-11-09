import { Monitor, Moon, Sun } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react'

export type Theme = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

interface ThemeContextType {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

// The colour modes, in the order the ⋯ menu and Settings > Appearance list
// them
export const THEMES = [
  { value: 'light', label: 'shell.menu.light', Icon: Sun },
  { value: 'dark', label: 'shell.menu.dark', Icon: Moon },
  { value: 'system', label: 'shell.menu.system', Icon: Monitor },
] as const

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

export const THEME_KEY = 'termote-theme'

const THEME_VALUES: readonly Theme[] = ['light', 'dark', 'system']

// A saved colour mode, kept only when it is one
export function resolveTheme(value: unknown): Theme {
  return THEME_VALUES.includes(value as Theme) ? (value as Theme) : 'system'
}

// The saved mode, read from storage on every call so a change made by
// another tab, or by an applied proposal, shows at once
const themeListeners = new Set<() => void>()

export function readStoredTheme(): Theme {
  try {
    return resolveTheme(localStorage.getItem(THEME_KEY))
  } catch {
    return 'system'
  }
}

function notifyTheme() {
  for (const fn of themeListeners) fn()
}

// Another tab of this browser changed the theme
function onThemeStorage(e: StorageEvent) {
  if (e.key === THEME_KEY || e.key === null) notifyTheme()
}

function subscribeTheme(listener: () => void) {
  if (!themeListeners.size) window.addEventListener('storage', onThemeStorage)
  themeListeners.add(listener)
  return () => {
    themeListeners.delete(listener)
    if (!themeListeners.size)
      window.removeEventListener('storage', onThemeStorage)
  }
}

// Save the colour mode of this browser; every ThemeProvider shows it
export function setStoredTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, resolveTheme(theme))
  } catch {
    // storage full or blocked: nothing to keep
  }
  notifyTheme()
}

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(
    subscribeTheme,
    readStoredTheme,
    /* v8 ignore next */
    () => 'system' as Theme,
  )

  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(getSystemTheme)
  const resolvedTheme: ResolvedTheme = theme === 'system' ? systemTheme : theme

  // Apply theme class to <html>. A layout effect, so it is in place before any
  // passive effect (the terminal, the theme-color sync) reads the tokens.
  // It never writes the mode back: another tab may have just saved one.
  useLayoutEffect(() => {
    const root = document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(resolvedTheme)
  }, [resolvedTheme])

  // Listen for system theme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      setSystemTheme(e.matches ? 'dark' : 'light')
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const setTheme = setStoredTheme

  return (
    <ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}
