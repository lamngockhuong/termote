// A place in a file written after its name, the way compilers, grep and
// agents write it: "name:12", "name:12:5", "name:12-20", "name:12,40". No
// React: plain functions.

// Lines marked in a file, from and to included (to >= from)
export interface LineMark {
  from: number
  to: number
}

export interface LineSuffix {
  // The text before the suffix
  rest: string
  // The numbers written; 0 or more, the caller says what it takes
  line: number
  col?: number
  // The range's last line ("-20")
  end?: number
  // A list ("12,40", "12-20,40"): every line or range in it, in order;
  // line and end are its first one's
  items?: { line: number; end?: number }[]
}

const ITEM = /^(\d+)(?:-(\d+))?$/

// ":12", ":12:5", ":12-20", ":12:5-20" or a list of lines and ranges
// (":176,183", ":12-20,40") at the end of s, or null without one. "C:\a" or
// "a:b" have none: only digits make one.
export function splitLineSuffix(s: string): LineSuffix | null {
  const list = /:(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)+)$/.exec(s)
  if (list) {
    const items = list[1].split(',').map((item) => {
      const m = ITEM.exec(item) as RegExpExecArray
      return {
        line: Number(m[1]),
        ...(m[2] !== undefined && { end: Number(m[2]) }),
      }
    })
    return { rest: s.slice(0, list.index), ...items[0], items }
  }
  const m = /:(\d+)(?::(\d+))?(?:-(\d+))?$/.exec(s)
  if (!m) return null
  return {
    rest: s.slice(0, m.index),
    line: Number(m[1]),
    ...(m[2] !== undefined && { col: Number(m[2]) }),
    ...(m[3] !== undefined && { end: Number(m[3]) }),
  }
}

// A range's last line, kept only when it comes after line: "12-20" is 12
// to 20; "20-12" or "12-12" are line 12 alone
export const rangeEnd = (line: number, end: number | undefined) =>
  end !== undefined && end > line ? end : undefined

// Where a suffix opens the file and the lines it marks: undefined when it
// names no line of 1 or more. A list keeps its lines of 1 or more (a range
// backwards is its first line); one line alone marks nothing more than
// the line it opens at.
export function suffixPlace(
  at: LineSuffix,
): { line: number; marks?: LineMark[] } | undefined {
  if (!at.items) {
    if (at.line < 1) return
    const to = rangeEnd(at.line, at.end)
    return {
      line: at.line,
      ...(to && { marks: [{ from: at.line, to }] }),
    }
  }
  const marks = at.items
    .filter((i) => i.line >= 1)
    .map((i) => ({ from: i.line, to: rangeEnd(i.line, i.end) ?? i.line }))
  if (!marks.length) return
  return { line: marks[0].from, marks }
}

// marks as a suffix is written: "391-398", "176,183"
export const formatMarks = (marks: LineMark[]) =>
  marks
    .map((m) => (m.to > m.from ? `${m.from}-${m.to}` : `${m.from}`))
    .join(',')

export interface FindQuery {
  // What is searched for: the name without the suffix
  name: string
  // Where the file chosen opens, and the lines it marks there
  line?: number
  col?: number
  marks?: LineMark[]
}

// A file search's query: "repo.ts:519", "repo.ts:519:7", "repo.ts:391-398"
// or "repo.ts:176,183" finds "repo.ts" and opens it at that line and
// column, the range or the lines marked. The suffix counts only when a name
// comes before it and it names a line of 1 or more (and a column of 1 or
// more); otherwise ("a.ts:0", ":12") the whole query is the name, as
// before. A range's end before its start is left out.
export function parseFindQuery(query: string): FindQuery {
  const q = query.trim()
  const at = splitLineSuffix(q)
  const place = at && suffixPlace(at)
  if (!at || !place || (at.col !== undefined && at.col < 1)) return { name: q }
  const name = at.rest.trim()
  if (!name) return { name: q }
  return {
    name,
    line: place.line,
    ...(at.col !== undefined && { col: at.col }),
    ...(place.marks && { marks: place.marks }),
  }
}
