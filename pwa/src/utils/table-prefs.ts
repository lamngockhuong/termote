import { loadTables, saveTables } from './files-persist'
import { type HastNode, textOf } from './markdown-links'

// How the reader set up a table of a Markdown file, kept in this browser:
// expanded or not, tall cells shown in full or not, the columns hidden and
// the widths dragged. A table is known by its file and its header row, so
// the same table keeps its set-up when the file is opened again, and two
// tables of one file with the same headers share it. Only what differs from
// the default is stored, with the Files records (files-persist.ts): gone 14
// days after it was last written, and at sign-out.

// Collapsed and expanded have very different widths to fill, so each keeps
// widths of its own; full screen counts as expanded.
export type TableMode = 'collapsed' | 'expanded'

export interface TablePrefs {
  expanded?: boolean
  unclamped?: boolean
  // Column indexes, ascending
  hidden?: number[]
  widths?: Partial<Record<TableMode, number[]>>
}

// The oldest set-ups go past this many
const MAX_TABLES = 300

// The header cells of a table's hast node (react-markdown's), in order:
// the nodes react-markdown hands each one's component
export function headerNodes(table: HastNode | undefined): HastNode[] {
  const head = table?.children?.find((n) => n.tagName === 'thead')
  const row = head?.children?.find((n) => n.tagName === 'tr')
  return (row?.children ?? []).filter((n) => n.tagName === 'th')
}

export function headerTexts(table: HastNode | undefined): string[] {
  return headerNodes(table).map((n) => textOf(n).trim())
}

// The header row's part of a key: the file writes it, so a header row of a
// megabyte would otherwise be stored (and written again with every table)
// whole. Tables of one file that share this much of it share a set-up.
const MAX_HEADERS = 512

// null: a table without a header row is not stored
export function tableKey(path: string, headers: string[]): string | null {
  if (!headers.length) return null
  return `${path}\n${headers.join('|').slice(0, MAX_HEADERS)}`
}

const isIndex = (n: unknown) => Number.isInteger(n) && (n as number) >= 0
const isWidth = (n: unknown) =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 100_000

// Only the parts of a stored value that have the right shape
function clean(value: unknown): TablePrefs {
  if (!value || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  const out: TablePrefs = {}
  if (v.expanded === true) out.expanded = true
  if (v.unclamped === true) out.unclamped = true
  if (Array.isArray(v.hidden) && v.hidden.length && v.hidden.every(isIndex)) {
    out.hidden = [...new Set(v.hidden as number[])].sort((a, b) => a - b)
  }
  if (v.widths && typeof v.widths === 'object') {
    const w = v.widths as Record<string, unknown>
    const widths: TablePrefs['widths'] = {}
    for (const mode of ['collapsed', 'expanded'] as const) {
      const list = w[mode]
      if (Array.isArray(list) && list.length && list.every(isWidth)) {
        widths[mode] = list as number[]
      }
    }
    if (widths.collapsed || widths.expanded) out.widths = widths
  }
  return out
}

export function readTablePrefs(key: string | null): TablePrefs {
  return key ? clean(loadTables()[key]) : {}
}

// Read again before writing: other tables share the store. The table written
// goes last, so the ones not touched for longest go first past MAX_TABLES.
// A failed write (full, no storage, signed out) keeps it for this view only.
export function writeTablePrefs(key: string | null, prefs: TablePrefs) {
  if (!key) return
  const now = Date.now()
  const all = loadTables(now)
  delete all[key]
  const value = clean(prefs)
  if (Object.keys(value).length) all[key] = { ...value, at: now }
  const keys = Object.keys(all)
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_TABLES))) {
    delete all[old]
  }
  saveTables(all)
}
