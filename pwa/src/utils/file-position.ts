// A place in a file written after its name, the way compilers, grep and
// agents write it: "name:12", "name:12:5", "name:12-20". No React: plain
// functions.

export interface LineSuffix {
  // The text before the suffix
  rest: string
  // The numbers written; 0 or more, the caller says what it takes
  line: number
  col?: number
  // The range's last line ("-20")
  end?: number
}

// ":12", ":12:5", ":12-20" or ":12:5-20" at the end of s, or null without
// one. "C:\a" or "a:b" have none: only digits make one.
export function splitLineSuffix(s: string): LineSuffix | null {
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

export interface FindQuery {
  // What is searched for: the name without the suffix
  name: string
  // Where the file chosen opens, and the last line of a range it marks
  line?: number
  col?: number
  endLine?: number
}

// A file search's query: "repo.ts:519", "repo.ts:519:7" or "repo.ts:391-398"
// finds "repo.ts" and opens it at that line and column, the range marked.
// The suffix counts only when a name comes before it and its line and
// column are 1 or more; otherwise ("a.ts:0", ":12") the whole query is the
// name, as before. A range's end before its start is left out.
export function parseFindQuery(query: string): FindQuery {
  const q = query.trim()
  const at = splitLineSuffix(q)
  if (!at || at.line < 1 || (at.col !== undefined && at.col < 1))
    return { name: q }
  const name = at.rest.trim()
  if (!name) return { name: q }
  const endLine = rangeEnd(at.line, at.end)
  return {
    name,
    line: at.line,
    ...(at.col !== undefined && { col: at.col }),
    ...(endLine && { endLine }),
  }
}
