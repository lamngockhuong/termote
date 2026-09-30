import { describe, expect, it } from 'vitest'
import { formatDeepLink, parseDeepLink } from './deep-link'

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
