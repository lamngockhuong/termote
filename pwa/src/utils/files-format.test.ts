import { describe, expect, it } from 'vitest'
import { formatSize, keepOrder, shortRoot, splitPath } from './files-format'

describe('files format', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1536, '1.5 KiB'],
    [3 * 1024 * 1024, '3.0 MiB'],
  ])('%i bytes is %s', (n, want) => {
    expect(formatSize(n)).toBe(want)
  })

  it.each([
    ['/home/kim/src/app', '~/src/app'],
    ['/home/kim', '~'],
    ['/Users/kim/x', '~/x'],
    ['/root/x', '~/x'],
    ['C:\\Users\\kim\\src', '~\\src'],
    ['/workspace/app', '/workspace/app'],
    // Not a home directory, only a name that starts the same
    ['/homeless/x', '/homeless/x'],
  ])('%s is shown as %s', (root, want) => {
    expect(shortRoot(root)).toBe(want)
  })

  it('splits a path into its directory and name', () => {
    expect(splitPath('a/b/c.ts')).toEqual(['a/b/', 'c.ts'])
    expect(splitPath('c.ts')).toEqual(['', 'c.ts'])
  })

  it('marks a path to keep its order when truncated from the start', () => {
    expect(keepOrder('/a/b')).toBe('\u200e/a/b\u200e')
  })
})
