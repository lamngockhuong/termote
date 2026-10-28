import { describe, expect, it } from 'vitest'
import { baseNameSelection, fileNameProblem, nameProblem } from './file-name'

describe('nameProblem', () => {
  it.each([
    ['', 'Enter a file name'],
    ['a/', 'Enter a file name after the last /'],
    ['a/../b', "A path can't go up with .."],
    ['a/b.md', undefined],
  ])('%j → %s', (p, want) => expect(nameProblem(p)).toBe(want))
})

describe('fileNameProblem', () => {
  it.each([
    ['notes.md', undefined],
    ['', 'Enter a file name'],
    ['a'.repeat(256), 'This name is too long'],
    ['é'.repeat(128), 'This name is too long'],
    ['a.', "A name can't end with a dot or a space"],
    ['a ', "A name can't end with a dot or a space"],
    ['a\tb', "A name can't hold control characters"],
    ['.termote-rename-0123456789abcdef', "This name can't be used"],
    ['.termote-edit-0123456789abcdef', "This name can't be used"],
    ['.termote-upload-0123456789abcdef', "This name can't be used"],
    ['.termote-edit-x', undefined],
  ])('%j → %s', (n, want) => expect(fileNameProblem(n)).toBe(want))
})

describe('baseNameSelection', () => {
  it.each([
    ['docs/report.final.md', [5, 17]],
    ['README', [0, 6]],
    ['a/.env', [2, 6]],
    ['a.b/c', [4, 5]],
  ])('%s → %j', (p, want) => expect(baseNameSelection(p)).toEqual(want))
})
