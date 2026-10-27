import { describe, expect, it } from 'vitest'
import type { DiffHunk } from '../hooks/use-mux-api'
import {
  diffRange,
  inPick,
  pickLine,
  pickSpan,
  selectedLines,
} from './line-range'

describe('pickLine', () => {
  it('picks one line, extends in its group, clears on the same line', () => {
    const one = pickLine(null, 0, 5, false)
    expect(one).toEqual({ group: 0, a: 5, b: 5 })
    expect(pickLine(one, 0, 9, true)).toEqual({ group: 0, a: 5, b: 9 })
    expect(pickLine(one, 0, 9, false)).toEqual({ group: 0, a: 9, b: 9 })
    // Another group starts again
    expect(pickLine(one, 1, 9, true)).toEqual({ group: 1, a: 9, b: 9 })
    expect(pickLine(one, 0, 5, true)).toBeNull()
    // Extend with nothing picked: one line
    expect(pickLine(null, 0, 3, true)).toEqual({ group: 0, a: 3, b: 3 })
  })

  it('reads a pick in order', () => {
    const p = { group: 2, a: 9, b: 4 }
    expect(pickSpan(p)).toEqual([4, 9])
    expect(pickSpan({ group: 0, a: 1, b: 2 })).toEqual([1, 2])
    expect(inPick(p, 2, 4)).toBe(true)
    expect(inPick(p, 2, 10)).toBe(false)
    expect(inPick(p, 2, 3)).toBe(false)
    expect(inPick(p, 1, 5)).toBe(false)
    expect(inPick(null, 0, 1)).toBe(false)
  })
})

const hunk: DiffHunk = {
  header: '@@ -10,4 +12,4 @@',
  lines: [
    { kind: 'ctx', old: 10, new: 12, text: 'a' },
    { kind: 'del', old: 11, text: 'b' },
    { kind: 'del', old: 12, text: 'c' },
    { kind: 'add', new: 13, text: 'B' },
    { kind: 'ctx', old: 13, new: 14, text: 'd' },
  ],
}

describe('diffRange', () => {
  it('numbers kept and added lines by the new side, deleted ones by the old', () => {
    expect(diffRange(hunk, 4, 0)).toEqual({
      start: 12,
      end: 14,
      removed: { start: 11, end: 12 },
      quote: ' a\n-b\n-c\n+B\n d',
    })
    expect(diffRange(hunk, 3, 3)).toEqual({ start: 13, end: 13, quote: '+B' })
  })

  it('puts deleted lines alone where they were removed', () => {
    expect(diffRange(hunk, 1, 2)).toEqual({
      start: 13,
      end: 13,
      removed: { start: 11, end: 12 },
      removedOnly: true,
      quote: '-b\n-c',
    })
    // After another deleted line
    expect(diffRange(hunk, 2, 2)).toMatchObject({
      start: 13,
      removed: { start: 12, end: 12 },
    })
    // At the top of a hunk: from its header (a file deleted whole: 0)
    const top: DiffHunk = {
      header: '@@ -4,1 +3,0 @@',
      lines: [{ kind: 'del', old: 4, text: 'x' }],
    }
    expect(diffRange(top, 0, 0)).toMatchObject({ start: 3, end: 3 })
    expect(diffRange({ ...top, header: 'odd' }, 0, 0)).toMatchObject({
      start: 1,
    })
  })
})

describe('selectedLines', () => {
  const text = 'one\ntwo\nthree\nfour'
  it('takes the whole lines a selection covers', () => {
    expect(selectedLines(text, 5, 9)).toEqual({
      from: 2,
      to: 3,
      lines: ['two', 'three'],
    })
    // Backwards, and a cursor alone
    expect(selectedLines(text, 9, 5).from).toBe(2)
    expect(selectedLines(text, 0, 0)).toEqual({
      from: 1,
      to: 1,
      lines: ['one'],
    })
  })

  it('leaves out the line a selection of whole lines ends at', () => {
    expect(selectedLines(text, 4, 14)).toEqual({
      from: 2,
      to: 3,
      lines: ['two', 'three'],
    })
  })
})
