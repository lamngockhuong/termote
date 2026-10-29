// Shown sizes and paths of the Files and Changes views.
import type { Locale } from '../i18n'

// One formatter per locale and number of decimals: a list of sizes (the
// trash holds up to 500) makes none of its own
const formats = new Map<string, Intl.NumberFormat>()
const num = (n: number, digits: number, locale: Locale) => {
  const key = `${locale}:${digits}`
  let f = formats.get(key)
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: false,
    })
    formats.set(key, f)
  }
  return f.format(n)
}

// "1023 B", "1.5 KiB", "3.0 MiB", with the locale's decimal mark
export function formatSize(bytes: number, locale: Locale): string {
  if (bytes < 1024) return `${num(bytes, 0, locale)} B`
  if (bytes < 1024 * 1024) return `${num(bytes / 1024, 1, locale)} KiB`
  return `${num(bytes / 1024 / 1024, 1, locale)} MiB`
}

// A root under a home directory as ~/…; the server does not say where home
// is, so the usual places are matched.
export function shortRoot(root: string): string {
  const m = root.match(
    /^(\/home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=$|[/\\])/,
  )
  return m ? `~${root.slice(m[0].length)}` : root
}

// "dir/sub/name" → ["dir/sub/", "name"]
export function splitPath(path: string): [dir: string, name: string] {
  const at = path.lastIndexOf('/') + 1
  return [path.slice(0, at), path.slice(at)]
}

// A long path loses its start, not its end (where the name is): the text runs
// right to left for the ellipsis, with marks that keep it in reading order.
export const TRUNCATE_START = 'truncate text-left [direction:rtl]'
export const keepOrder = (path: string) => `\u200e${path}\u200e`
