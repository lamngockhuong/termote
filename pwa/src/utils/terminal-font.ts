// Bundled font carrying only the Nerd Font icons (declared in index.css,
// limited to their code points by unicode-range).
export const SYMBOLS_FONT = 'Symbols Nerd Font Mono'

// Monospace fonts commonly installed on each OS, tried before the icons.
const SYSTEM_MONO =
  'ui-monospace, Menlo, Monaco, Consolas, "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", "Courier New"'

const GENERIC = new Set([
  'monospace',
  'ui-monospace',
  'serif',
  'sans-serif',
  'system-ui',
])

// Quotes each family name in a comma-separated list, so a name such as
// "Fira Code 5" stays valid CSS; names already quoted and generic families
// are kept as typed.
function quoteFamilies(list: string): string[] {
  return list
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) =>
      /^["']/.test(name) || GENERIC.has(name.toLowerCase())
        ? name
        : `"${name.replace(/"/g, '')}"`,
    )
}

// CSS font-family for the terminal: the user's font first (one installed on
// this device, e.g. a full Nerd Font), then the system monospace fonts, then
// the bundled icons for any glyph none of those has.
export function terminalFontFamily(custom = ''): string {
  return [
    ...quoteFamilies(custom),
    SYSTEM_MONO,
    `"${SYMBOLS_FONT}"`,
    'monospace',
  ].join(', ')
}
