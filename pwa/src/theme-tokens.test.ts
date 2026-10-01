// Static checks on the token sources: index.css (tokens), index.html (pre-paint
// script, theme-color) and vite.config.ts (manifest). jsdom does not load the
// stylesheet, so the files are imported as text.
import { describe, expect, it } from 'vitest'
import html from '../index.html?raw'
import viteConfig from '../vite.config.ts?raw'
import css from './index.css?raw'
import { DEFAULT_UI_STYLE, resolveUiStyle, UI_STYLES } from './ui-style'

// Declarations of the rule whose selector list is exactly `selector`.
function block(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`))
  if (!match) throw new Error(`no rule for ${selector}`)
  return new Map(
    [...match[1].matchAll(/(--tm-[\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].trim(),
    ]),
  )
}

const selectors = (style: string) =>
  style === DEFAULT_UI_STYLE
    ? {
        light: `:root,\n:root[data-ui-style="${style}"]`,
        dark: `:root.dark,\n:root[data-ui-style="${style}"].dark`,
      }
    : {
        light: `:root[data-ui-style="${style}"]`,
        dark: `:root[data-ui-style="${style}"].dark`,
      }

const shared = block(':root')
const styles = UI_STYLES.map(({ id }) => ({
  id,
  light: block(selectors(id).light),
  dark: block(selectors(id).dark),
}))
const themeInline = css.match(/@theme inline \{([^}]*)\}/)![1]
const referenced = [...themeInline.matchAll(/var\((--tm-[\w-]+)\)/g)].map(
  (m) => m[1],
)
const colorTokens = [
  ...themeInline.matchAll(/--color-[\w-]+:\s*var\((--tm-[\w-]+)\)/g),
].map((m) => m[1])
// A style may override a shared token (motion durations); the rest must match.
const names = (m: Map<string, string>) =>
  [...m.keys()].filter((n) => !shared.has(n)).sort()

describe('design tokens', () => {
  it.each(styles)('$id defines every token the Tailwind names use', (s) => {
    for (const name of referenced) {
      expect(s.light.has(name) || shared.has(name), name).toBe(true)
    }
  })

  it.each(styles)('$id dark overrides every colour token', (s) => {
    for (const name of colorTokens) expect(s.dark.has(name), name).toBe(true)
    for (const name of s.dark.keys()) expect(s.light.has(name), name).toBe(true)
  })

  it('gives every style the same token names', () => {
    const [first, ...rest] = styles
    for (const s of rest) {
      expect(names(s.light), s.id).toEqual(names(first.light))
      expect(names(s.dark), s.id).toEqual(names(first.dark))
    }
  })

  it('makes neutral the fallback when data-ui-style is missing', () => {
    expect(css).toContain(
      `:root,\n:root[data-ui-style="${DEFAULT_UI_STYLE}"] {`,
    )
    // Neutral comes first: the other styles override it at equal specificity.
    const neutralAt = css.indexOf(':root,\n:root[data-ui-style="neutral"]')
    for (const id of ['terminal', 'native']) {
      expect(css.indexOf(`:root[data-ui-style="${id}"] {`)).toBeGreaterThan(
        neutralAt,
      )
    }
  })

  it('declares a ui-* variant per style', () => {
    for (const { id } of UI_STYLES) {
      expect(css).toContain(
        `@custom-variant ui-${id} (&:where([data-ui-style="${id}"] *));`,
      )
    }
  })

  it('turns motion off for users who ask for less', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^@]*animation-duration: 0\.01ms !important;[^@]*transition-duration: 0\.01ms !important;/,
    )
  })
})

// WCAG relative luminance and contrast ratio of two #rrggbb colours
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('diff colours', () => {
  const modes = styles.flatMap((s) => [
    { name: `${s.id} light`, t: s.light },
    { name: `${s.id} dark`, t: s.dark },
  ])
  it.each(modes)('$name: diff text and line numbers stay readable', ({ t }) => {
    for (const bg of ['--tm-diff-add', '--tm-diff-del']) {
      for (const fg of ['--tm-fg', '--tm-fg-muted']) {
        expect(
          contrast(t.get(fg)!, t.get(bg)!),
          `${fg} on ${bg}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('pre-paint script and browser colours', () => {
  const neutral = styles.find((s) => s.id === DEFAULT_UI_STYLE)!
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]

  // Runs the inline script as the page would, with `saved` in termote-settings.
  function runScript(saved: string | null) {
    localStorage.clear()
    if (saved !== null) localStorage.setItem('termote-settings', saved)
    document.documentElement.removeAttribute('data-ui-style')
    document.documentElement.classList.remove('light', 'dark')
    new Function(script)()
    return document.documentElement.getAttribute('data-ui-style')
  }

  it.each<[string, string | null]>([
    ['no saved settings', null],
    ['settings without uiStyle', '{"pollInterval":5}'],
    ['a null style', '{"uiStyle":null}'],
    ['an unknown style', '{"uiStyle":"fancy"}'],
    ['corrupt JSON', '{not json'],
    ['a JSON null', 'null'],
    ...UI_STYLES.map((s): [string, string] => [
      s.id,
      JSON.stringify({ uiStyle: s.id }),
    ]),
  ])('picks the same style as resolveUiStyle for %s', (_, saved) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(saved ?? '{}')?.uiStyle
    } catch {
      parsed = undefined
    }
    expect(runScript(saved)).toBe(resolveUiStyle(parsed))
  })

  it('starts theme-color at the default style background', () => {
    expect(html).toContain(
      `<meta name="theme-color" content="${neutral.dark.get('--tm-bg')}" media="(prefers-color-scheme: dark)" />`,
    )
    expect(html).toContain(
      `<meta name="theme-color" content="${neutral.light.get('--tm-bg')}" media="(prefers-color-scheme: light)" />`,
    )
  })

  it('gives the manifest the default style dark background', () => {
    const bg = neutral.dark.get('--tm-bg')
    expect(viteConfig).toContain(`theme_color: '${bg}'`)
    expect(viteConfig).toContain(`background_color: '${bg}'`)
  })
})
