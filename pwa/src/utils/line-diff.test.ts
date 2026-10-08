import { describe, expect, it } from 'vitest'
import { diffLines, diffSummary, parseUnifiedDiff } from './line-diff'

const kinds = (rows: { kind: string }[]) => rows.map((r) => r.kind).join(' ')

describe('diffLines', () => {
  it('keeps shared lines and marks the changed ones', () => {
    const rows = diffLines('a\nb\nc\nd\n', 'a\nx\nc\nd\ne\n')
    expect(kinds(rows)).toBe('ctx del add ctx ctx add')
    expect(rows.map((r) => r.text)).toEqual(['a', 'b', 'x', 'c', 'd', 'e'])
  })

  it('matches lines inside the changed middle', () => {
    expect(kinds(diffLines('p\nq\nr', 'q\nr\ns'))).toBe('del ctx ctx add')
    expect(kinds(diffLines('a\nb', 'b\na'))).toBe('del ctx add')
  })

  it('handles empty sides', () => {
    expect(diffLines('', '')).toEqual([])
    expect(kinds(diffLines('', 'x\ny'))).toBe('add add')
    expect(kinds(diffLines('x\n', ''))).toBe('del')
  })

  it('does not match past the table limit', () => {
    const a = Array.from({ length: 600 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 600 }, (_, i) => `b${i}`).join('\n')
    const rows = diffLines(`h\n${a}\nt`, `h\n${b}\nt`)
    expect(rows[0].kind).toBe('ctx')
    expect(rows[1].kind).toBe('del')
    expect(rows[601].kind).toBe('add')
    expect(rows[rows.length - 1]).toEqual({ kind: 'ctx', text: 't' })
  })
})

describe('parseUnifiedDiff', () => {
  it('drops headers and classifies lines', () => {
    const rows = parseUnifiedDiff(
      '--- a/x\n+++ b/x\n@@ -1 +1 @@\n same\n-a\n+b\n',
    )
    expect(rows).toEqual([
      { kind: 'ctx', text: 'same' },
      { kind: 'del', text: 'a' },
      { kind: 'add', text: 'b' },
    ])
  })
})

describe('diffSummary', () => {
  it('names what an edit did', () => {
    expect(diffSummary(diffLines('a', 'a\nb'))).toBe('Added 1 line')
    expect(diffSummary(diffLines('a\nb\nc', 'a'))).toBe('Removed 2 lines')
    expect(diffSummary(diffLines('a', 'b'))).toBe('Modified')
    expect(diffSummary([])).toBe('No changes')
  })
})
