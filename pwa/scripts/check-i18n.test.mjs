import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checked, compare, countFiles, countText, lowered, main } from './check-i18n.mjs'

describe('countText', () => {
  it('counts JSX text on one line', () => {
    expect(countText('<span>Hello world</span>')).toBe(1)
    expect(countText('<b>Count: {n}</b>')).toBe(1)
    expect(countText('<p>{count} files selected</p>')).toBe(1)
    expect(countText('<b>Data &amp; help</b>')).toBe(1)
  })

  it('reads no text in a comparison, an else or a template', () => {
    expect(countText('if (a > b) {')).toBe(0)
    expect(countText('} else {')).toBe(0)
    expect(countText('}: Props) {')).toBe(0)
    expect(countText("}: Omit<Props, 'isOpen'>) {")).toBe(0)
    expect(countText('function f(t: Translate<Key>): string {')).toBe(0)
    expect(countText("notify(t('a.b', { n }), 'warning', {")).toBe(0)
    expect(countText('const s = `${n} files${x}`')).toBe(0)
  })

  it('counts words alone under a tag', () => {
    expect(countText('<h2 id="x">\n  Touch Gestures\n</h2>')).toBe(1)
    expect(countText('<Button\n  onClick={go}>\n  Got it\n</Button>')).toBe(1)
    expect(countText('<p\n  className="x"\n>\n  Got it\n</p>')).toBe(1)
  })

  it('reads no text under a type', () => {
    expect(countText("  side: NonNullable<X['side']>\n  at: number")).toBe(0)
  })

  it('counts literal labels, titles and placeholders', () => {
    expect(countText('<button aria-label="Close panel" />')).toBe(1)
    expect(countText("<input placeholder='Search files' />")).toBe(1)
    expect(countText("{ label: 'Swipe left', description: 'Cancel it' }")).toBe(2)
  })

  it('skips text that goes through t() and code', () => {
    expect(countText("<span>{t('common.ok')}</span>")).toBe(0)
    expect(countText('if (a.length > 0 && b.length < 3) return')).toBe(0)
    expect(countText('const f = () =>\n  value')).toBe(0)
    expect(countText('<button aria-label={label} />')).toBe(0)
    expect(countText('<i title={`${name} file`} />')).toBe(0)
    expect(countText("{ title: 'tour.chipTitle' }")).toBe(0)
    expect(countText("{ label: 'shell.agent.done' }")).toBe(0)
    expect(countText('<span>{n}</span> <b>+</b>')).toBe(0)
  })

  it('reads no JSX text in a .ts file, nor a type after an arrow', () => {
    expect(countText('prompt: () => Promise<void>', false)).toBe(0)
    expect(countText('<span>Hello world</span>', false)).toBe(0)
    expect(countText('<p>\n  Hello world\n</p>', false)).toBe(0)
    expect(countText('const f = (): Promise<X> => go()')).toBe(0)
    expect(countText("{ label: 'Swipe left' }", false)).toBe(1)
  })

  it('skips comments and lines marked i18n-ignore', () => {
    expect(countText('// <span>Hello world</span>')).toBe(0)
    expect(countText(' * <span>Hello world</span>')).toBe(0)
    expect(countText('<kbd>Esc</kbd> // i18n-ignore')).toBe(0)
    expect(countText('{/* i18n-ignore */}\n<kbd>Esc</kbd>')).toBe(0)
  })
})

describe('checked', () => {
  it('reads source, never tests, catalogs or declarations', () => {
    expect(checked('src/App.tsx')).toBe(true)
    expect(checked('src/utils/a.ts')).toBe(true)
    expect(checked('src/App.test.tsx')).toBe(false)
    expect(checked('src/i18n/messages/en/common.ts')).toBe(false)
    expect(checked('src/i18n/test-utils.tsx')).toBe(false)
    expect(checked('src/vite-env.d.ts')).toBe(false)
    expect(checked('src/index.css')).toBe(false)
  })
})

describe('compare and lowered', () => {
  it('names each file over its allowance, a new file allowed none', () => {
    expect(compare({ a: 2, b: 1, c: 1 }, { a: 2, b: 0 })).toEqual([
      { name: 'b', count: 1, allowed: 0 },
      { name: 'c', count: 1, allowed: 0 },
    ])
  })

  it('lowers counts and drops files at none', () => {
    expect(lowered({ a: 1 }, { a: 3, b: 2 }, true)).toEqual({ a: 1 })
  })

  it('keeps files it did not read on a partial scan', () => {
    expect(lowered({ a: 1 }, { b: 2, a: 3 }, false)).toEqual({ a: 1, b: 2 })
  })
})

describe('countFiles and main', () => {
  let dir
  afterEach(() => {
    vi.restoreAllMocks()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('counts the whole of src', () => {
    dir = mkdtempSync(join(process.cwd(), 'src/.check-i18n-'))
    const file = join(dir, 'x.tsx')
    writeFileSync(file, '<span>Hello world</span>\n')
    const counts = countFiles()
    expect(counts[file.slice(process.cwd().length + 1)]).toBe(1)
    expect(Object.keys(counts).every((k) => k.startsWith('src/'))).toBe(true)
  })

  it('ignores a file outside src', () => {
    expect(countFiles([join(process.cwd(), 'scripts/check-i18n.mjs')])).toEqual({})
  })

  it('passes on the repository as it is', () => {
    expect(main([])).toBe(0)
    expect(main(['src/main.tsx'])).toBe(0)
  })

  it('fails on a staged file with new text, and --update does not raise it', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    dir = mkdtempSync(join(process.cwd(), 'src/.check-i18n-'))
    const file = join(dir, 'x.tsx')
    writeFileSync(file, '<span>Hello world</span>\n')
    const name = file.slice(process.cwd().length + 1)
    const before = readFileSync('i18n-baseline.json', 'utf8')
    expect(main([name])).toBe(1)
    expect(main(['--update', name])).toBe(1)
    expect(readFileSync('i18n-baseline.json', 'utf8')).toBe(before)
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('1 interface strings outside t(), 0 allowed'),
    )
  })

  it('--update keeps the baseline when nothing went down', () => {
    const before = readFileSync('i18n-baseline.json', 'utf8')
    expect(main(['--update', 'src/main.tsx'])).toBe(0)
    expect(readFileSync('i18n-baseline.json', 'utf8')).toBe(before)
  })

  it('asks for a baseline when there is none, and writes one with --update', () => {
    dir = mkdtempSync(join(tmpdir(), 'check-i18n-'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const opts = { baseline: join(dir, 'b.json') }
    expect(main([], opts)).toBe(1)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('no i18n-baseline.json'))
    expect(main(['--update'], opts)).toBe(0)
    expect(JSON.parse(readFileSync(opts.baseline, 'utf8'))).toEqual(countFiles())
  })
})
