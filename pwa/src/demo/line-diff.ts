import type { DiffHunk, DiffLine } from '../hooks/use-mux-api'

// The unified diff of two texts as the server sends it (files/diff): hunks
// with three lines of context, each header naming the function above it as
// git's default does (the last line starting with a letter, _ or $).

const CONTEXT = 3

// A last line without a newline ends in NOEOL, so it differs from the same
// line with one, as in git
const NOEOL = '\u0000'

function lines(text: string): string[] {
  if (text === '') return []
  const all = text.split('\n')
  if (all[all.length - 1] === '') all.pop()
  else all[all.length - 1] += NOEOL
  return all
}

function line(kind: DiffLine['kind'], text: string): DiffLine {
  return text.endsWith(NOEOL)
    ? { kind, text: text.slice(0, -1), noNewline: true }
    : { kind, text }
}

// One edit script from a to b, Myers' greedy algorithm: the same shortest
// script git finds, deletions before insertions where both fit
function script(a: string[], b: string[]): DiffLine['kind'][] {
  const n = a.length
  const m = b.length
  const max = n + m
  const v = new Map<number, number>([[1, 0]])
  const trace: Map<number, number>[] = []
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v.set(k, x)
      if (x >= n && y >= m) return backtrack(trace, n, m)
    }
  }
  /* v8 ignore next */
  throw new Error('unreachable')
}

function backtrack(
  trace: Map<number, number>[],
  n: number,
  m: number,
): DiffLine['kind'][] {
  const out: DiffLine['kind'][] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]
    const k = x - y
    const down =
      k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))
    const prevK = down ? k + 1 : k - 1
    const prevX = v.get(prevK) ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      out.push('ctx')
      x--
      y--
    }
    if (d > 0) out.push(down ? 'add' : 'del')
    x = prevX
    y = prevY
  }
  return out.reverse()
}

const FUNC = /^[A-Za-z_$]/

function findLast<T>(list: T[], ok: (item: T) => boolean): T | undefined {
  for (let i = list.length - 1; i >= 0; i--) if (ok(list[i])) return list[i]
  return undefined
}

export function diffHunks(oldText: string, newText: string): DiffHunk[] {
  const a = lines(oldText)
  const b = lines(newText)
  const all: DiffLine[] = []
  let i = 0
  let j = 0
  for (const kind of script(a, b)) {
    if (kind === 'ctx') all.push({ ...line(kind, a[i]), old: ++i, new: ++j })
    else if (kind === 'del') all.push({ ...line(kind, a[i]), old: ++i })
    else all.push({ ...line(kind, b[j]), new: ++j })
  }
  const changed = all.flatMap((l, n) => (l.kind === 'ctx' ? [] : [n]))
  const hunks: DiffHunk[] = []
  let start = 0
  while (start < changed.length) {
    let end = start
    while (
      end + 1 < changed.length &&
      changed[end + 1] - changed[end] <= 2 * CONTEXT + 1
    )
      end++
    const from = Math.max(0, changed[start] - CONTEXT)
    const to = Math.min(all.length, changed[end] + CONTEXT + 1)
    hunks.push(hunk(all.slice(from, to), a))
    start = end + 1
  }
  return hunks
}

function hunk(body: DiffLine[], a: string[]): DiffHunk {
  const olds = body.filter((l) => l.kind !== 'add')
  const news = body.filter((l) => l.kind !== 'del')
  // Where the hunk starts on each side; an empty side names the line before
  const oldStart = olds[0]?.old ?? 0
  const newStart = news[0]?.new ?? 0
  const range = (s: number, c: number) => (c === 1 ? `${s}` : `${s},${c}`)
  const above = findLast(a.slice(0, Math.max(0, oldStart - 1)), (l) =>
    FUNC.test(l),
  )
  const header = `@@ -${range(oldStart, olds.length)} +${range(newStart, news.length)} @@${above ? ` ${above}` : ''}`
  return { header, lines: body }
}
