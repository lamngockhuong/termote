// Static checks on the token sources: index.css (tokens), index.html (pre-paint
// script, theme-color) and vite.config.ts (manifest). jsdom does not load the
// stylesheet, so the files are imported as text.
import { describe, expect, it } from 'vitest'
import html from '../index.html?raw'
import viteConfig from '../vite.config.ts?raw'
import css from './index.css?raw'
import {
  type AccentColor,
  accentColor,
  DEFAULT_UI_STYLE,
  resolveUiAccent,
  resolveUiStyle,
  UI_ACCENTS,
  UI_STYLES,
} from './ui-style'

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

describe('avatar colours', () => {
  const modes = styles.flatMap((s) => [
    { name: `${s.id} light`, t: s.light },
    { name: `${s.id} dark`, t: s.dark },
  ])
  it.each(modes)('$name: a white letter reads on every avatar', ({ t }) => {
    for (let i = 1; i <= 8; i++) {
      const bg = t.get(`--tm-avatar-${i}`)!
      expect(
        contrast('#ffffff', bg),
        `--tm-avatar-${i} ${bg}`,
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})

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

// APCA 0.0.98G-4g lightness contrast (Lc) of light text on a dark background,
// as a magnitude (APCA reports it negative)
function apcaDarkLc(text: string, bg: string) {
  const y = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(
      (i) => (Number.parseInt(hex.slice(i, i + 2), 16) / 255) ** 2.4,
    )
    const v = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
    // biome-ignore lint/suspicious/noApproximativeNumericConstant: APCA's black clamp exponent, not √2
    return v < 0.022 ? v + (0.022 - v) ** 1.414 : v
  }
  const sapc = (y(bg) ** 0.65 - y(text) ** 0.62) * 1.14
  return sapc > -0.1 ? 0 : -(sapc + 0.027) * 100
}

describe('dark text brightness', () => {
  // Every style lands on the same perceived contrast, readable but no brighter
  it.each([
    ['--tm-fg', 68, 73],
    ['--tm-fg-muted', 50, 55],
    ['--tm-fg-subtle', 41, 46],
  ])('%s sits within Lc %i-%i on --tm-bg', (fg, min, max) => {
    for (const s of styles) {
      const lc = apcaDarkLc(s.dark.get(fg)!, s.dark.get('--tm-bg')!)
      expect(lc, s.id).toBeGreaterThanOrEqual(min)
      expect(lc, s.id).toBeLessThanOrEqual(max)
    }
  })

  it.each(styles)('$id dark text keeps 4.5:1 on every surface', (s) => {
    for (const fg of ['--tm-fg', '--tm-fg-muted', '--tm-fg-subtle']) {
      for (const bg of ['--tm-bg', '--tm-surface', '--tm-surface-raised']) {
        expect(
          contrast(s.dark.get(fg)!, s.dark.get(bg)!),
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
    document.documentElement.removeAttribute('data-accent')
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

  it.each<[string, string | null]>([
    ['no saved settings', null],
    ['settings without uiAccent', '{"uiStyle":"native"}'],
    ['a null accent', '{"uiAccent":null}'],
    ['an unknown accent', '{"uiAccent":"gold"}'],
    ['a non-string accent', '{"uiAccent":["teal"]}'],
    ['corrupt JSON', '{not json'],
    ['a JSON null', 'null'],
    ...UI_ACCENTS.map((a): [string, string] => [
      a.id,
      JSON.stringify({ uiAccent: a.id }),
    ]),
  ])('picks the same accent as resolveUiAccent for %s', (_, saved) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(saved ?? '{}')?.uiAccent
    } catch {
      parsed = undefined
    }
    runScript(saved)
    const accent = resolveUiAccent(parsed)
    expect(document.documentElement.getAttribute('data-accent')).toBe(
      accent === 'auto' ? null : accent,
    )
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

// #rrggbb or rgb(r g b / a) as 0-255 channels and an alpha
function parseColor(value: string): { rgb: number[]; alpha: number } {
  if (value.startsWith('#')) {
    return {
      rgb: [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)),
      alpha: 1,
    }
  }
  const m = value.match(/^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/)
  if (!m) throw new Error(`unparsed colour ${value}`)
  return { rgb: [m[1], m[2], m[3]].map(Number), alpha: Number(m[4]) }
}
const toHex = (rgb: number[]) =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
// `top` at `alpha` over an opaque `bottom`, both #rrggbb or rgb()
function over(top: number[], alpha: number, bottom: string) {
  const b = parseColor(bottom).rgb
  return toHex(top.map((c, i) => c * alpha + b[i] * (1 - alpha)))
}

describe('accent colors', () => {
  const colors = UI_ACCENTS.filter((a): a is AccentColor => a.id !== 'auto')
  const accentBlocks = colors.map((a) => ({
    a,
    light: block(`:root[data-accent="${a.id}"]`),
    dark: block(`:root[data-accent="${a.id}"].dark`),
  }))
  const modes = styles.flatMap((s) => [
    { style: s.id, dark: false, t: s.light },
    { style: s.id, dark: true, t: s.dark },
  ])
  const surfaces = ['--tm-bg', '--tm-surface', '--tm-surface-raised']
  const softBases = [...surfaces, '--tm-term-bg']
  const softAlpha = (t: Map<string, string>) =>
    Number(t.get('--tm-accent-soft-alpha'))

  it('keeps every block in index.css equal to UI_ACCENTS', () => {
    for (const { a, light, dark } of accentBlocks) {
      for (const [m, pair] of [
        [light, a.light],
        [dark, a.dark],
      ] as const) {
        expect(m.get('--tm-accent'), a.id).toBe(pair[0])
        expect(m.get('--tm-accent-fg'), a.id).toBe(pair[1])
        const [r, g, b] = parseColor(pair[0]).rgb
        expect(m.get('--tm-accent-soft'), a.id).toBe(
          `rgb(${r} ${g} ${b} / var(--tm-accent-soft-alpha))`,
        )
      }
    }
    expect(accentColor('teal')).toBe(colors.find((c) => c.id === 'teal'))
  })

  it('keeps each style own accent in UI_STYLES equal to its token', () => {
    for (const s of UI_STYLES) {
      const t = styles.find((x) => x.id === s.id)!
      expect(t.light.get('--tm-accent'), s.id).toBe(s.accent.light)
      expect(t.dark.get('--tm-accent'), s.id).toBe(s.accent.dark)
    }
  })

  it('puts the accent blocks after every style block', () => {
    const firstAccent = css.indexOf(':root[data-accent=')
    for (const { id } of UI_STYLES) {
      expect(css.indexOf(selectors(id).dark), id).toBeLessThan(firstAccent)
      expect(css.indexOf(selectors(id).light), id).toBeLessThan(firstAccent)
    }
  })

  it.each(
    accentBlocks.flatMap(({ a }) =>
      modes.map((m) => ({
        name: `${a.id} on ${m.style} ${m.dark ? 'dark' : 'light'}`,
        pair: m.dark ? a.dark : a.light,
        t: m.t,
      })),
    ),
  )('$name: buttons and accent text keep 4.5:1', ({ pair, t }) => {
    const [accent, fg] = pair
    expect(contrast(fg, accent), 'accent-fg on accent').toBeGreaterThanOrEqual(
      4.5,
    )
    for (const bg of surfaces) {
      expect(contrast(accent, t.get(bg)!), bg).toBeGreaterThanOrEqual(4.5)
    }
  })

  // Accent text on the soft tint (the selected tab, segment or item). The
  // style accents already miss 4.5 there; a chosen color may be no worse
  // than the worst of them, and never below 3.
  const autoSoftWorst = Math.min(
    ...modes.flatMap(({ t }) => {
      const soft = parseColor(t.get('--tm-accent-soft')!)
      return softBases.map((bg) =>
        contrast(t.get('--tm-accent')!, over(soft.rgb, soft.alpha, t.get(bg)!)),
      )
    }),
  )

  it.each(
    accentBlocks.flatMap(({ a }) =>
      modes.map((m) => ({
        name: `${a.id} on ${m.style} ${m.dark ? 'dark' : 'light'}`,
        accent: (m.dark ? a.dark : a.light)[0],
        t: m.t,
      })),
    ),
  )(
    '$name: accent text on the soft tint is no worse than the style accents',
    ({ accent, t }) => {
      const rgb = parseColor(accent).rgb
      for (const bg of softBases) {
        const ratio = contrast(accent, over(rgb, softAlpha(t), t.get(bg)!))
        expect(ratio, bg).toBeGreaterThanOrEqual(3)
        expect(ratio, bg).toBeGreaterThanOrEqual(autoSoftWorst)
      }
    },
  )
})
