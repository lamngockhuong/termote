import { describe, expect, it } from 'vitest'
import {
  formatMarks,
  parseFindQuery,
  rangeEnd,
  splitLineSuffix,
  suffixPlace,
} from './file-position'

describe('splitLineSuffix', () => {
  it('splits a line, a column and a range off the end', () => {
    expect(splitLineSuffix('a.ts:12')).toEqual({ rest: 'a.ts', line: 12 })
    expect(splitLineSuffix('a.ts:12:5')).toEqual({
      rest: 'a.ts',
      line: 12,
      col: 5,
    })
    expect(splitLineSuffix('a.ts:12-20')).toEqual({
      rest: 'a.ts',
      line: 12,
      end: 20,
    })
    expect(splitLineSuffix('a.ts:12:5-20')).toEqual({
      rest: 'a.ts',
      line: 12,
      col: 5,
      end: 20,
    })
    expect(splitLineSuffix('a.ts:0')).toEqual({ rest: 'a.ts', line: 0 })
  })

  it('finds none without digits at the end', () => {
    expect(splitLineSuffix('a.ts')).toBeNull()
    expect(splitLineSuffix('C:\\src\\a.ts')).toBeNull()
    expect(splitLineSuffix('a:b.ts')).toBeNull()
    expect(splitLineSuffix('a.ts:')).toBeNull()
    expect(splitLineSuffix('a.ts:12a')).toBeNull()
    expect(splitLineSuffix('a.ts:12-')).toBeNull()
    expect(splitLineSuffix('a.ts:12,')).toBeNull()
    expect(splitLineSuffix('a.ts:12:5,9')).toEqual({
      rest: 'a.ts:12',
      line: 5,
      items: [{ line: 5 }, { line: 9 }],
    })
  })

  it('splits a list of lines and ranges off the end', () => {
    expect(splitLineSuffix('a.ts:176,183')).toEqual({
      rest: 'a.ts',
      line: 176,
      items: [{ line: 176 }, { line: 183 }],
    })
    expect(splitLineSuffix('a.ts:12-20,40')).toEqual({
      rest: 'a.ts',
      line: 12,
      end: 20,
      items: [{ line: 12, end: 20 }, { line: 40 }],
    })
  })
})

describe('suffixPlace', () => {
  it('opens at the first line of 1 or more and marks what a list names', () => {
    expect(suffixPlace({ rest: 'a', line: 12 })).toEqual({ line: 12 })
    expect(suffixPlace({ rest: 'a', line: 0 })).toBeUndefined()
    expect(suffixPlace({ rest: 'a', line: 3, end: 9 })).toEqual({
      line: 3,
      marks: [{ from: 3, to: 9 }],
    })
    expect(
      suffixPlace({
        rest: 'a',
        line: 0,
        items: [{ line: 0 }, { line: 20, end: 12 }, { line: 30, end: 33 }],
      }),
    ).toEqual({
      line: 20,
      marks: [
        { from: 20, to: 20 },
        { from: 30, to: 33 },
      ],
    })
    expect(
      suffixPlace({ rest: 'a', line: 0, items: [{ line: 0 }, { line: 0 }] }),
    ).toBeUndefined()
  })
})

describe('formatMarks', () => {
  it('writes marks the way a suffix is written', () => {
    expect(formatMarks([{ from: 391, to: 398 }])).toBe('391-398')
    expect(
      formatMarks([
        { from: 176, to: 176 },
        { from: 183, to: 190 },
      ]),
    ).toBe('176,183-190')
  })
})

describe('rangeEnd', () => {
  it('keeps an end only after the start', () => {
    expect(rangeEnd(391, 398)).toBe(398)
    expect(rangeEnd(398, 391)).toBeUndefined()
    expect(rangeEnd(12, 12)).toBeUndefined()
    expect(rangeEnd(12, undefined)).toBeUndefined()
  })
})

describe('parseFindQuery', () => {
  it('takes a line and column after the name', () => {
    expect(parseFindQuery('order-service.repository.ts:519')).toEqual({
      name: 'order-service.repository.ts',
      line: 519,
    })
    expect(parseFindQuery(' repo.ts:519:7 ')).toEqual({
      name: 'repo.ts',
      line: 519,
      col: 7,
    })
    expect(parseFindQuery('src/repo.ts:3-9')).toEqual({
      name: 'src/repo.ts',
      line: 3,
      marks: [{ from: 3, to: 9 }],
    })
  })

  it('takes a range of lines, its end only when it comes after the start', () => {
    expect(parseFindQuery('repository.ts:391-398')).toEqual({
      name: 'repository.ts',
      line: 391,
      marks: [{ from: 391, to: 398 }],
    })
    expect(parseFindQuery('repository.ts:391:4-398')).toEqual({
      name: 'repository.ts',
      line: 391,
      col: 4,
      marks: [{ from: 391, to: 398 }],
    })
    // Backwards or one line: the start alone
    expect(parseFindQuery('repository.ts:398-391')).toEqual({
      name: 'repository.ts',
      line: 398,
    })
    expect(parseFindQuery('repository.ts:7-7')).toEqual({
      name: 'repository.ts',
      line: 7,
    })
    expect(parseFindQuery('repository.ts:0-9')).toEqual({
      name: 'repository.ts:0-9',
    })
  })

  it('takes a list of lines, each marked, opening at the first', () => {
    expect(parseFindQuery('update-order.dto.ts:176,183')).toEqual({
      name: 'update-order.dto.ts',
      line: 176,
      marks: [
        { from: 176, to: 176 },
        { from: 183, to: 183 },
      ],
    })
    expect(parseFindQuery('a.ts:12-20,40')).toEqual({
      name: 'a.ts',
      line: 12,
      marks: [
        { from: 12, to: 20 },
        { from: 40, to: 40 },
      ],
    })
    // Lines of 0 are left out; none left: the whole query
    expect(parseFindQuery('a.ts:0,7')).toEqual({
      name: 'a.ts',
      line: 7,
      marks: [{ from: 7, to: 7 }],
    })
    expect(parseFindQuery('a.ts:0,0')).toEqual({ name: 'a.ts:0,0' })
    expect(parseFindQuery(':176,183')).toEqual({ name: ':176,183' })
    expect(parseFindQuery('C:\\src\\a.ts:1,2')).toMatchObject({
      name: 'C:\\src\\a.ts',
      line: 1,
    })
    expect(parseFindQuery('a.ts:12,x')).toEqual({ name: 'a.ts:12,x' })
  })

  it('keeps a Windows path, its drive and the colons in a name', () => {
    expect(parseFindQuery('C:\\src\\a.ts:12')).toEqual({
      name: 'C:\\src\\a.ts',
      line: 12,
    })
    expect(parseFindQuery('C:\\src\\a.ts')).toEqual({ name: 'C:\\src\\a.ts' })
    expect(parseFindQuery('a:b.ts:4')).toEqual({ name: 'a:b.ts', line: 4 })
    expect(parseFindQuery('12:30.log')).toEqual({ name: '12:30.log' })
  })

  it('is the whole query without a name or a number of 1 or more', () => {
    expect(parseFindQuery('main')).toEqual({ name: 'main' })
    expect(parseFindQuery('')).toEqual({ name: '' })
    expect(parseFindQuery(':12')).toEqual({ name: ':12' })
    expect(parseFindQuery('  :12')).toEqual({ name: ':12' })
    expect(parseFindQuery('a.ts:0')).toEqual({ name: 'a.ts:0' })
    expect(parseFindQuery('a.ts:12:0')).toEqual({ name: 'a.ts:12:0' })
    expect(parseFindQuery('a.ts:')).toEqual({ name: 'a.ts:' })
  })
})
