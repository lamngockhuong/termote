import { describe, expect, it } from 'vitest'
import { PERSIST_TTL, signedOut, sweepExpired } from './files-persist'
import {
  headerTexts,
  readTablePrefs,
  tableKey,
  writeTablePrefs,
} from './table-prefs'

const STORE = 'termote-md-tables'

const th = (text: string) => ({
  type: 'element',
  tagName: 'th',
  children: [{ type: 'text', value: ` ${text} ` }],
})

describe('table prefs', () => {
  it('knows a table by its file and header texts', () => {
    const node = {
      type: 'element',
      tagName: 'table',
      children: [
        { type: 'text', value: '\n' },
        {
          type: 'element',
          tagName: 'thead',
          children: [
            { type: 'element', tagName: 'tr', children: [th('a'), th('b')] },
          ],
        },
      ],
    }
    expect(headerTexts(node)).toEqual(['a', 'b'])
    expect(tableKey('x.md', ['a', 'b'])).toBe('x.md\na|b')
    expect(headerTexts(undefined)).toEqual([])
    expect(tableKey('x.md', [])).toBeNull()
    // A header row of any length makes a key of bounded length
    expect(tableKey('x.md', ['h'.repeat(100_000)])).toHaveLength(5 + 512)
  })

  it('reads a key named like an Object property as its own entry only', () => {
    const at = Date.now()
    expect(readTablePrefs('constructor')).toEqual({})
    expect(readTablePrefs('toString')).toEqual({})
    // JSON.parse makes "__proto__" an own key: it stays data, never a prototype
    localStorage.setItem(
      STORE,
      `{"__proto__":{"at":${at},"expanded":true},"constructor":{"at":${at},"unclamped":true}}`,
    )
    expect(readTablePrefs('__proto__')).toEqual({ expanded: true })
    expect(readTablePrefs('constructor')).toEqual({ unclamped: true })
    expect(readTablePrefs('other')).toEqual({})
    writeTablePrefs('other', { expanded: true })
    expect(Object.keys(JSON.parse(localStorage.getItem(STORE) ?? ''))).toEqual([
      '__proto__',
      'constructor',
      'other',
    ])
  })

  it('stores only what differs from the default, and reads it back', () => {
    writeTablePrefs('k', {
      expanded: true,
      unclamped: false,
      hidden: [2, 0, 2],
      widths: { expanded: [100, 80] },
    })
    expect(readTablePrefs('k')).toEqual({
      expanded: true,
      hidden: [0, 2],
      widths: { expanded: [100, 80] },
    })
    writeTablePrefs('k', { expanded: false })
    expect(readTablePrefs('k')).toEqual({})
    // Nothing left: the store goes
    expect(localStorage.getItem(STORE)).toBeNull()
  })

  it('keeps the other tables when one is written', () => {
    writeTablePrefs('a', { expanded: true })
    writeTablePrefs('b', { unclamped: true })
    expect(readTablePrefs('a')).toEqual({ expanded: true })
    expect(readTablePrefs('b')).toEqual({ unclamped: true })
  })

  it('drops values of the wrong shape, and a store that is not JSON', () => {
    localStorage.setItem(
      STORE,
      JSON.stringify({
        k: {
          at: Date.now(),
          expanded: 'yes',
          hidden: [1, -1],
          widths: { collapsed: [10, 'x'], expanded: [Infinity] },
        },
      }),
    )
    expect(readTablePrefs('k')).toEqual({})
    localStorage.setItem(STORE, '{')
    expect(readTablePrefs('k')).toEqual({})
    // A header named like a property of every object is a key like any other
    expect(readTablePrefs('__proto__')).toEqual({})
    expect(readTablePrefs(null)).toEqual({})
    // A table without a header row is not stored
    writeTablePrefs(null, { expanded: true })
    expect(localStorage.getItem(STORE)).toBe('{')
  })

  it('forgets the tables not touched for longest past 300', () => {
    for (let i = 0; i < 302; i++) writeTablePrefs(`t${i}`, { expanded: true })
    writeTablePrefs('t2', { unclamped: true })
    const stored = Object.keys(JSON.parse(localStorage.getItem(STORE) ?? ''))
    expect(stored).toHaveLength(300)
    expect(stored).not.toContain('t0')
    expect(stored).not.toContain('t1')
    expect(stored).toContain('t3')
    expect(stored.at(-1)).toBe('t2')
  })

  it('forgets a table not written for 14 days', () => {
    const now = Date.now()
    localStorage.setItem(
      STORE,
      JSON.stringify({
        old: { at: now - PERSIST_TTL - 1, expanded: true },
        none: { expanded: true },
        recent: { at: now, expanded: true },
      }),
    )
    expect(readTablePrefs('old')).toEqual({})
    expect(readTablePrefs('none')).toEqual({})
    expect(readTablePrefs('recent')).toEqual({ expanded: true })
    // Swept when the PWA loads, even if the table is never opened again
    sweepExpired(now)
    expect(Object.keys(JSON.parse(localStorage.getItem(STORE) ?? ''))).toEqual([
      'recent',
    ])
  })

  it('removes every table at sign-out, and writes none after it', () => {
    writeTablePrefs('a', { expanded: true })
    expect(localStorage.getItem(STORE)).not.toBeNull()
    signedOut()
    expect(localStorage.getItem(STORE)).toBeNull()
    writeTablePrefs('b', { expanded: true })
    expect(localStorage.getItem(STORE)).toBeNull()
  })

  it('writes none once another tab signed out', () => {
    localStorage.setItem('termote-signed-out', String(Date.now()))
    writeTablePrefs('a', { expanded: true })
    expect(localStorage.getItem(STORE)).toBeNull()
  })
})
