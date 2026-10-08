// Line diff of an edit's old and new text, for the Chat view's Edit card.
// The texts are a few KiB at most (the server caps them), so a plain LCS
// table is enough; past MAX_CELLS the old lines are shown removed and the
// new ones added, without matching.

export interface DiffRow {
  kind: 'ctx' | 'add' | 'del'
  text: string
}

const MAX_CELLS = 250_000

function lines(text: string): string[] {
  if (text === '') return []
  const l = text.split('\n')
  if (l[l.length - 1] === '') l.pop()
  return l
}

export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = lines(oldText)
  const b = lines(newText)
  // Lines shared at both ends need no table
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head = a.slice(0, start).map((text) => ({ kind: 'ctx' as const, text }))
  const tail = a.slice(endA).map((text) => ({ kind: 'ctx' as const, text }))
  const x = a.slice(start, endA)
  const y = b.slice(start, endB)
  const n = x.length
  const m = y.length
  const del = (text: string): DiffRow => ({ kind: 'del', text })
  const add = (text: string): DiffRow => ({ kind: 'add', text })
  if (n * m > MAX_CELLS) {
    return [...head, ...x.map(del), ...y.map(add), ...tail]
  }
  // lcs[i][j]: longest common subsequence of x[i..] and y[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        x[i] === y[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  const mid: DiffRow[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      mid.push({ kind: 'ctx', text: x[i] })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      mid.push(del(x[i++]))
    } else {
      mid.push(add(y[j++]))
    }
  }
  while (i < n) mid.push(del(x[i++]))
  while (j < m) mid.push(add(y[j++]))
  return [...head, ...mid, ...tail]
}

// The rows of a unified diff (a Codex file change): hunk headers and file
// headers are dropped, the rest classified by their first character.
export function parseUnifiedDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = []
  for (const line of lines(text)) {
    if (/^(@@|\+\+\+ |--- |diff --git |index |\\ No newline)/.test(line)) {
      continue
    }
    if (line.startsWith('+')) rows.push({ kind: 'add', text: line.slice(1) })
    else if (line.startsWith('-'))
      rows.push({ kind: 'del', text: line.slice(1) })
    else rows.push({ kind: 'ctx', text: line.replace(/^ /, '') })
  }
  return rows
}

// What an edit did, in the words of the card under its title: added or
// removed when the line count changed, else modified.
export function diffSummary(rows: DiffRow[]): string {
  let adds = 0
  let dels = 0
  for (const r of rows) {
    if (r.kind === 'add') adds++
    else if (r.kind === 'del') dels++
  }
  const plural = (k: number) => `${k} line${k === 1 ? '' : 's'}`
  if (adds === 0 && dels === 0) return 'No changes'
  if (adds > dels) return `Added ${plural(adds - dels)}`
  if (dels > adds) return `Removed ${plural(dels - adds)}`
  return 'Modified'
}
