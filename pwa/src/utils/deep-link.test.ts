import { describe, expect, it } from 'vitest'
import {
  formatDeepLink,
  formatOverviewLink,
  OVERVIEW_HASH,
  parseDeepLink,
  parseScreenLink,
  parseSolo,
} from './deep-link'

describe('parseDeepLink', () => {
  it('reads group and tab', () => {
    expect(parseDeepLink('#/s/main/2')).toEqual({ group: 'main', tab: '2' })
  })

  it('reads a pane and a view', () => {
    expect(parseDeepLink('#/s/w1/t3/p7?view=chat')).toEqual({
      group: 'w1',
      tab: 't3',
      pane: 'p7',
      view: 'chat',
    })
  })

  it('accepts a trailing slash', () => {
    expect(parseDeepLink('#/s/main/2/')).toEqual({ group: 'main', tab: '2' })
  })

  it('decodes each segment', () => {
    expect(parseDeepLink('#/s/my%20work/a%2Fb')).toEqual({
      group: 'my work',
      tab: 'a/b',
    })
  })

  it('ignores an empty view', () => {
    expect(parseDeepLink('#/s/main/2?view=')).toEqual({
      group: 'main',
      tab: '2',
    })
  })

  it.each([
    [''],
    ['#'],
    ['#/settings'],
    ['#/s/'],
    ['#/s/main'],
    ['#/s/main/1/2/3'],
    ['#/s//1'],
    ['#/s/main/..'],
    ['#/s/./1'],
    ['#/s/%E0%A4%A/1'],
  ])('refuses %j', (hash) => {
    expect(parseDeepLink(hash)).toBeNull()
  })
})

describe('formatDeepLink', () => {
  it('leaves out the pane and the default view', () => {
    expect(formatDeepLink({ group: 'main', tab: '2', view: 'terminal' })).toBe(
      '#/s/main/2',
    )
  })

  it('writes a pane and another view', () => {
    expect(
      formatDeepLink({ group: 'w1', tab: 't3', pane: 'p7', view: 'files' }),
    ).toBe('#/s/w1/t3/p7?view=files')
  })

  it('round-trips ids with special characters', () => {
    const link = { group: 'a b/c?', tab: '#1', pane: '..x%', view: 'chat' }
    expect(parseDeepLink(formatDeepLink(link))).toEqual(link)
  })
})

describe('parseScreenLink', () => {
  it('names the overview, with or without a trailing slash', () => {
    expect(parseScreenLink(OVERVIEW_HASH)).toBe('overview')
    expect(parseScreenLink('#/overview/')).toBe('overview')
  })
  it('is null for a pane link or anything else', () => {
    expect(parseScreenLink('#/s/main/0')).toBeNull()
    expect(parseScreenLink('#/overviews')).toBeNull()
    expect(parseScreenLink('')).toBeNull()
    expect(parseDeepLink(OVERVIEW_HASH)).toBeNull()
  })
})

describe('focus links', () => {
  it('reads solo', () => {
    expect(parseDeepLink('#/s/main/2?solo=1')).toEqual({
      group: 'main',
      tab: '2',
      solo: true,
    })
    expect(parseDeepLink('#/s/main/2?solo=0')).toEqual({
      group: 'main',
      tab: '2',
    })
  })

  it('reads a file in the Files view', () => {
    expect(
      parseDeepLink('#/s/w1/t3/p7?view=files&solo=1&file=src%2Fa%20b.ts'),
    ).toEqual({
      group: 'w1',
      tab: 't3',
      pane: 'p7',
      view: 'files',
      solo: true,
      file: 'src/a b.ts',
    })
  })

  it('keeps staged and orig for the Changes view only', () => {
    expect(
      parseDeepLink('#/s/w/t?view=changes&file=b.ts&staged=1&orig=a.ts'),
    ).toEqual({
      group: 'w',
      tab: 't',
      view: 'changes',
      file: 'b.ts',
      staged: true,
      orig: 'a.ts',
    })
    expect(
      parseDeepLink('#/s/w/t?view=files&file=b.ts&staged=1&orig=a.ts'),
    ).toEqual({ group: 'w', tab: 't', view: 'files', file: 'b.ts' })
  })

  it('reads and writes the unstaged side of a diff', () => {
    const link = { group: 'w', tab: 't', view: 'changes', file: 'b.ts' }
    expect(parseDeepLink('#/s/w/t?view=changes&file=b.ts')).toEqual(link)
    expect(formatDeepLink(link)).toBe('#/s/w/t?view=changes&file=b.ts')
  })

  it('ignores a file in a view that shows none', () => {
    expect(parseDeepLink('#/s/w/t?file=a.ts')).toEqual({ group: 'w', tab: 't' })
    expect(parseDeepLink('#/s/w/t?view=chat&file=a.ts')).toEqual({
      group: 'w',
      tab: 't',
      view: 'chat',
    })
  })

  it.each([
    [''],
    ['/etc/passwd'],
    ['../x'],
    ['a/../../x'],
    ['a//b'],
    ['./a'],
    ['a/'],
    ['C:%5Cx'],
    ['C:x'],
    ['a%5Cb'],
    ['a%00b'],
  ])('marks the file %j as bad', (file) => {
    expect(parseDeepLink(`#/s/w/t?view=files&file=${file}`)).toEqual({
      group: 'w',
      tab: 't',
      view: 'files',
      badFile: true,
    })
  })

  it('marks a bad orig as a bad file', () => {
    expect(parseDeepLink('#/s/w/t?view=changes&file=b.ts&orig=..%2Fa')).toEqual(
      { group: 'w', tab: 't', view: 'changes', badFile: true },
    )
  })

  it('formats the focus fields in a fixed order', () => {
    expect(
      formatDeepLink({
        group: 'w',
        tab: 't',
        view: 'changes',
        solo: true,
        file: 'dir/b c.ts',
        staged: true,
        orig: 'a+b.ts',
      }),
    ).toBe(
      '#/s/w/t?view=changes&solo=1&file=dir%2Fb%20c.ts&staged=1&orig=a%2Bb.ts',
    )
    expect(formatDeepLink({ group: 'w', tab: 't', solo: true })).toBe(
      '#/s/w/t?solo=1',
    )
  })

  it('leaves out a file the view does not show, and staged outside Changes', () => {
    expect(
      formatDeepLink({ group: 'w', tab: 't', view: 'chat', file: 'a.ts' }),
    ).toBe('#/s/w/t?view=chat')
    expect(formatDeepLink({ group: 'w', tab: 't', file: 'a.ts' })).toBe(
      '#/s/w/t',
    )
    expect(
      formatDeepLink({
        group: 'w',
        tab: 't',
        view: 'files',
        file: 'a.ts',
        staged: true,
        orig: 'b.ts',
      }),
    ).toBe('#/s/w/t?view=files&file=a.ts')
  })

  it.each([
    [{ group: 'w', tab: 't', view: 'files', solo: true, file: 'ü/ñ +x.md' }],
    [
      {
        group: 'a b',
        tab: '#1',
        pane: 'p',
        view: 'changes',
        file: 'x&y=z.ts',
        staged: true,
        orig: 'q?.ts',
      },
    ],
  ])('round-trips %j', (link) => {
    expect(parseDeepLink(formatDeepLink(link as never))).toEqual(link)
  })
})

describe('overview focus links', () => {
  it('formats the overview, solo or not', () => {
    expect(formatOverviewLink()).toBe(OVERVIEW_HASH)
    expect(formatOverviewLink({ solo: true })).toBe('#/overview?solo=1')
  })

  it('names the overview with a query', () => {
    expect(parseScreenLink('#/overview?solo=1')).toBe('overview')
    expect(parseScreenLink('#/overview/?solo=1')).toBe('overview')
  })
})

describe('parseSolo', () => {
  it.each([
    ['#/overview?solo=1', true],
    ['#/overview', false],
    ['#/overview?solo=0', false],
    ['#/s/w/t?solo=1', true],
    ['#/s/w/t?view=files&solo=1&file=a', true],
    ['#/s/w/t', false],
    ['#/s/w?solo=1', false],
    ['', false],
  ])('%j is %s', (hash, solo) => {
    expect(parseSolo(hash)).toBe(solo)
  })
})
