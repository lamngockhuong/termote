// UI styles the user picks in Settings. Each one is a token set in index.css,
// selected by data-ui-style on <html>. index.html sets the attribute before
// React runs (so the page never paints another style first) with an inline copy
// of resolveUiStyle; theme-tokens.test.ts keeps the two in step.

export const UI_STYLES = [
  { id: 'neutral', label: 'Neutral' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'native', label: 'Native' },
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
