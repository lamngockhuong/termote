// Random CSV files for the parser and patch tests: seeded, so a failing
// case replays the same way.
import type { Delimiter } from './csv-parse'

// A deterministic generator, so a failing case can be replayed
export function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const PIECES = [
  'a',
  'b',
  ' ',
  '"',
  ',',
  ';',
  '\n',
  '\r\n',
  'é',
  '😀',
  'x"y',
  '',
]

// A random CSV that parses: cells either plain or quoted, any content
export function randomCsv(
  rand: () => number,
  delimiter: Delimiter = ',',
): string {
  const nRows = Math.floor(rand() * 6)
  const lines: string[] = []
  for (let r = 0; r < nRows; r++) {
    const nCells = 1 + Math.floor(rand() * 4)
    const cells: string[] = []
    for (let c = 0; c < nCells; c++) {
      let v = ''
      const len = Math.floor(rand() * 4)
      for (let i = 0; i < len; i++)
        v += PIECES[Math.floor(rand() * PIECES.length)]
      if (rand() < 0.5 || /["\n\r,;]/.test(v) || v.includes(delimiter)) {
        cells.push(`"${v.replace(/"/g, '""')}"`)
      } else cells.push(v)
    }
    lines.push(cells.join(delimiter))
  }
  const eol = rand() < 0.5 ? '\n' : '\r\n'
  const bom = rand() < 0.3 ? '\uFEFF' : ''
  return bom + lines.join(eol) + (lines.length && rand() < 0.5 ? eol : '')
}
