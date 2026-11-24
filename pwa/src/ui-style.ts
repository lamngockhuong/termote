// UI styles the user picks in Settings. Each one is a token set in index.css,
// selected by data-ui-style on <html>. index.html sets the attribute before
// React runs (so the page never paints another style first) with an inline copy
// of resolveUiStyle; theme-tokens.test.ts keeps the two in step.

// Settings names each one (STYLE_LABEL in components/settings-modal.tsx).
// accent is the style's own --tm-accent (light, dark): Settings draws it even
// while an accent color overrides the token.
export const UI_STYLES = [
  { id: 'neutral', accent: { light: '#4f46e5', dark: '#818cf8' } },
  { id: 'terminal', accent: { light: '#0d7a41', dark: '#3ddc84' } },
  { id: 'native', accent: { light: '#0062cc', dark: '#4c9cf8' } },
] as const

export type UiStyle = (typeof UI_STYLES)[number]['id']

export const DEFAULT_UI_STYLE: UiStyle = 'neutral'

// A stored value from an older or edited config may be anything.
export function resolveUiStyle(value: unknown): UiStyle {
  return UI_STYLES.some((s) => s.id === value)
    ? (value as UiStyle)
    : DEFAULT_UI_STYLE
}

export function applyUiStyle(style: UiStyle) {
  document.documentElement.dataset.uiStyle = resolveUiStyle(style)
}

// Accent colors, independent of the style the way light and dark are. 'auto'
// keeps the style's own accent; any other one sets data-accent on <html>, whose
// blocks in index.css override --tm-accent, --tm-accent-fg and --tm-accent-soft
// (theme-tokens.test.ts checks the values match and the contrast on every
// style). index.html applies it before React runs, like the style.
export const UI_ACCENTS = [
  { id: 'auto' },
  { id: 'indigo', light: ['#4f46e5', '#ffffff'], dark: ['#818cf8', '#0b0b1a'] },
  { id: 'blue', light: ['#0062cc', '#ffffff'], dark: ['#4c9cf8', '#050d18'] },
  { id: 'teal', light: ['#0f766e', '#ffffff'], dark: ['#2dd4bf', '#04201c'] },
  { id: 'green', light: ['#0d7a41', '#ffffff'], dark: ['#3ddc84', '#04140b'] },
  { id: 'orange', light: ['#b83f0b', '#ffffff'], dark: ['#fb923c', '#1f0d02'] },
  { id: 'pink', light: ['#be185d', '#ffffff'], dark: ['#f472b6', '#22061a'] },
  { id: 'violet', light: ['#7c3aed', '#ffffff'], dark: ['#a78bfa', '#120a26'] },
] as const

export type UiAccent = (typeof UI_ACCENTS)[number]['id']
export type AccentColor = Exclude<(typeof UI_ACCENTS)[number], { id: 'auto' }>

export const DEFAULT_UI_ACCENT: UiAccent = 'auto'

export function resolveUiAccent(value: unknown): UiAccent {
  return UI_ACCENTS.some((a) => a.id === value)
    ? (value as UiAccent)
    : DEFAULT_UI_ACCENT
}

// The colors of an accent other than 'auto'
export function accentColor(accent: UiAccent): AccentColor | undefined {
  return UI_ACCENTS.find(
    (a): a is AccentColor => a.id === accent && a.id !== 'auto',
  )
}

export function applyUiAccent(accent: UiAccent) {
  const resolved = resolveUiAccent(accent)
  if (resolved === 'auto') {
    delete document.documentElement.dataset.accent
  } else {
    document.documentElement.dataset.accent = resolved
  }
}

// Reads a raw token (e.g. --tm-bg) for the current style and theme; empty when
// the stylesheet is not loaded (tests).
export function readToken(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
}

// The browser chrome takes the app background. Run it after both the style and
// the theme class are on <html>.
export function syncThemeColor() {
  const color = readToken('--tm-bg')
  if (!color) return
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', color)
  }
}
