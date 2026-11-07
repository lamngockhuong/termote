import { describe, expect, it } from 'vitest'
import { absolutePath, fileName, mentionPath, pasteable } from './file-paths'

describe('fileName', () => {
  it('is the last part of the path', () => {
    expect(fileName('src/app/main.ts')).toBe('main.ts')
    expect(fileName('README.md')).toBe('README.md')
  })
})

describe('absolutePath', () => {
  it('joins a Unix root and the path', () => {
    expect(absolutePath('/home/me/repo', 'src/a.ts')).toBe(
      '/home/me/repo/src/a.ts',
    )
    expect(absolutePath('/home/me/repo/', 'a.ts')).toBe('/home/me/repo/a.ts')
    expect(absolutePath('/', 'etc/hosts')).toBe('/etc/hosts')
  })

  it('is the root itself for the root', () => {
    expect(absolutePath('/home/me/repo', '')).toBe('/home/me/repo')
  })

  it('uses backslashes under a Windows drive or share', () => {
    expect(absolutePath('C:\\Users\\me\\repo', 'src/a.ts')).toBe(
      'C:\\Users\\me\\repo\\src\\a.ts',
    )
    expect(absolutePath('C:\\', 'a.ts')).toBe('C:\\a.ts')
    expect(absolutePath('C:/work/', 'a.ts')).toBe('C:\\work\\a.ts')
    expect(absolutePath('\\\\server\\share', 'docs/x.md')).toBe(
      '\\\\server\\share\\docs\\x.md',
    )
  })

  it("keeps a symlink's own path", () => {
    expect(absolutePath('/repo', 'link-to-elsewhere')).toBe(
      '/repo/link-to-elsewhere',
    )
  })
})

describe('mentionPath', () => {
  const root = '/home/me/repo'

  it('is relative to the pane directory for a file below it', () => {
    expect(mentionPath({ root, dir: 'pwa', path: 'pwa/src/App.tsx' })).toBe(
      '@src/App.tsx',
    )
  })

  it('is relative to the root when the pane sits at the root', () => {
    expect(mentionPath({ root, path: 'server/main.go' })).toBe(
      '@server/main.go',
    )
  })

  it('is absolute outside the pane directory, for the root, or in a Place', () => {
    expect(mentionPath({ root, dir: 'pwa', path: 'server/main.go' })).toBe(
      '@/home/me/repo/server/main.go',
    )
    // pwa-old starts with pwa but is not below it
    expect(mentionPath({ root, dir: 'pwa', path: 'pwa-old/a' })).toBe(
      '@/home/me/repo/pwa-old/a',
    )
    expect(mentionPath({ root, dir: 'pwa', path: 'pwa' })).toBe(
      '@/home/me/repo/pwa',
    )
    expect(mentionPath({ root, path: '' })).toBe('@/home/me/repo')
    // Where the pane is not known
    expect(mentionPath({ root, dir: null, path: 'a.ts' })).toBe(
      '@/home/me/repo/a.ts',
    )
    expect(
      mentionPath({ root: '/home/me/notes', place: 'p1', path: 'todo.md' }),
    ).toBe('@/home/me/notes/todo.md')
  })

  it('quotes a path with whitespace', () => {
    expect(mentionPath({ root, path: 'docs/my notes.md' })).toBe(
      '@"docs/my notes.md"',
    )
    expect(
      mentionPath({ root: 'C:\\Users\\Jane Doe', place: 'p', path: 'a.txt' }),
    ).toBe('@"C:\\Users\\Jane Doe\\a.txt"')
  })
})

describe('pasteable', () => {
  it('refuses a line break, a control character or a quote', () => {
    expect(pasteable('/home/me/my notes.md')).toBe(true)
    expect(pasteable('@src/a.ts')).toBe(true)
    for (const bad of [
      'a\nb',
      'a\rb',
      'a\tb',
      'a\u0003b',
      'a\u007fb',
      'a\u009bb',
      'a"b',
    ])
      expect(pasteable(bad)).toBe(false)
  })
})
