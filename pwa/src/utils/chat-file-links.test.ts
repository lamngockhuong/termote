import { describe, expect, it } from 'vitest'
import {
  fileRefFromHref,
  isAbsolutePath,
  parseFileRef,
  underRoot,
} from './chat-file-links'

describe('parseFileRef', () => {
  it.each([
    ['pwa/src/a.ts', { path: 'pwa/src/a.ts' }],
    ['pwa/src/a.ts:12', { path: 'pwa/src/a.ts', line: 12 }],
    ['pwa/src/a.ts:12:5', { path: 'pwa/src/a.ts', line: 12 }],
    ['pwa/src/a.ts:12-20', { path: 'pwa/src/a.ts', line: 12 }],
    ['docs/a.md#L3', { path: 'docs/a.md', line: 3 }],
    ['docs/a.md#L3-L9', { path: 'docs/a.md', line: 3 }],
    ['docs/a.md#intro', { path: 'docs/a.md' }],
    [' server/.env.example ', { path: 'server/.env.example' }],
    ['server/.gitignore', { path: 'server/.gitignore' }],
    ['/home/u/p/Makefile', { path: '/home/u/p/Makefile' }],
    ['./scripts/run', { path: './scripts/run' }],
    ['../x/y', { path: '../x/y' }],
    ['server/Dockerfile:4', { path: 'server/Dockerfile', line: 4 }],
    ['C:\\work\\a.ts', { path: 'C:\\work\\a.ts' }],
    ['src\\a.ts:2', { path: 'src\\a.ts', line: 2 }],
  ])('%s', (text, want) => {
    expect(parseFileRef(text)).toEqual(want)
  })

  it.each([
    '',
    'README.md',
    'window.location',
    'and/or',
    'text/html',
    'owner/repo',
    '1/2',
    'src/',
    'https://example.com/a.ts',
    'mailto:a@b.c',
    '//host/a.ts',
    '~/notes/a.md',
    'src/**/*.ts',
    'a/b.ts c/d.ts',
    'fn(a/b.ts)',
    'x=a/b.ts',
    '$HOME/a.ts',
    'a.ts:0',
    `${'a/'.repeat(600)}b.ts`,
  ])('not %s', (text) => {
    expect(parseFileRef(text)).toBeNull()
  })

  it('takes any path from a link', () => {
    expect(parseFileRef('README.md', true)).toEqual({ path: 'README.md' })
    expect(parseFileRef('Makefile:3', true)).toEqual({
      path: 'Makefile',
      line: 3,
    })
    expect(parseFileRef('a b.md', true)).toEqual({ path: 'a b.md' })
    expect(parseFileRef('a\u0000b.md', true)).toBeNull()
  })
})

describe('fileRefFromHref', () => {
  it.each([
    ['README.md', { path: 'README.md' }],
    ['docs/a%20b.md', { path: 'docs/a b.md' }],
    ['docs/a.md?raw=1#L4', { path: 'docs/a.md', line: 4 }],
    ['pwa/src/x.ts', { path: 'pwa/src/x.ts' }],
  ])('%s', (href, want) => {
    expect(fileRefFromHref(href)).toEqual(want)
  })

  it.each([
    undefined,
    '',
    '#intro',
    'https://a.b/c',
    'javascript:alert(1)',
    '//evil.example/a',
    '%E0%A4%A',
  ])('not %s', (href) => {
    expect(fileRefFromHref(href)).toBeNull()
  })
})

describe('isAbsolutePath', () => {
  it.each(['/a', 'C:\\a', 'c:/a', '\\a'])('%s', (p) => {
    expect(isAbsolutePath(p)).toBe(true)
  })
  it.each(['a', './a', 'C:a'])('not %s', (p) => {
    expect(isAbsolutePath(p)).toBe(false)
  })
})

describe('underRoot', () => {
  it.each([
    ['/r/p/a.ts', '/r/p', 'a.ts'],
    ['/r/p/a.ts', '/r/p/', 'a.ts'],
    ['/r/p', '/r/p', ''],
    ['a.ts', '/r/p', 'a.ts'],
    ['./x/../a.ts', '/r/p', 'a.ts'],
    ['x//y/./a.ts', '', 'x/y/a.ts'],
    ['src\\a.ts', '/r', 'src/a.ts'],
    ['c:\\Work\\P\\a.ts', 'C:\\work\\p', 'a.ts'],
    ['C:/work/p/src/a.ts', 'C:\\work\\p', 'src/a.ts'],
  ])('%s under %s', (path, root, want) => {
    expect(underRoot(path, root)).toBe(want)
  })

  it.each([
    ['/r/pq/a.ts', '/r/p'],
    ['/R/p/a.ts', '/r/p'],
    ['/elsewhere/a.ts', '/r/p'],
    ['/r/p/a.ts', ''],
    ['../a.ts', '/r/p'],
    ['x/../../a.ts', '/r/p'],
    ['D:\\p\\a.ts', 'C:\\p'],
  ])('not %s under %s', (path, root) => {
    expect(underRoot(path, root)).toBeNull()
  })
})
