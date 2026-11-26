import { describe, expect, it } from 'vitest'
import { parseFindQuery, rangeEnd, splitLineSuffix } from './file-position'

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
      endLine: 9,
    })
  })

  it('takes a range of lines, its end only when it comes after the start', () => {
    expect(parseFindQuery('repository.ts:391-398')).toEqual({
      name: 'repository.ts',
      line: 391,
      endLine: 398,
    })
    expect(parseFindQuery('repository.ts:391:4-398')).toEqual({
      name: 'repository.ts',
      line: 391,
      col: 4,
      endLine: 398,
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
