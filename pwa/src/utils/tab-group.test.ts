import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import {
  collapsedKey,
  dropGroup,
  dropTabIndex,
  joinTabGroup,
  readCollapsed,
  type StripItem,
  splitTabGroup,
  stripItems,
  tabGroupFill,
  tabGroupLine,
  tabGroupMoveIndex,
  tabGroupNewName,
  writeCollapsed,
} from './tab-group'

const tab = (id: string, name: string, extra: Partial<Session> = {}) =>
  ({ id, name, icon: '', description: '', ...extra }) as Session

describe('splitTabGroup', () => {
  it('splits at the first slash', () => {
    expect(splitTabGroup('review/PR 1')).toEqual({
      group: 'review',
      label: 'PR 1',
    })
    expect(splitTabGroup('review/feat/x')).toEqual({
      group: 'review',
      label: 'feat/x',
    })
  })

  it('trims both parts', () => {
    expect(splitTabGroup('review / PR 1')).toEqual({
      group: 'review',
      label: 'PR 1',
    })
  })

  it('leaves a name without a slash alone', () => {
    expect(splitTabGroup('Shell')).toEqual({ label: 'Shell' })
  })

  it('leaves a name with an empty part alone', () => {
    expect(splitTabGroup('/tmp')).toEqual({ label: '/tmp' })
    expect(splitTabGroup('logs/')).toEqual({ label: 'logs/' })
    expect(splitTabGroup(' / ')).toEqual({ label: ' / ' })
  })

  it('leaves a path alone', () => {
    expect(splitTabGroup('~/notes')).toEqual({ label: '~/notes' })
    expect(splitTabGroup('./run')).toEqual({ label: './run' })
    expect(splitTabGroup('../up')).toEqual({ label: '../up' })
  })
})

describe('joinTabGroup', () => {
  it('puts the group before the name', () => {
    expect(joinTabGroup('review', 'PR 1')).toBe('review/PR 1')
  })

  it('keeps the name without one', () => {
    expect(joinTabGroup(undefined, 'PR 1')).toBe('PR 1')
  })
})

describe('stripItems', () => {
  const tabs = [
    tab('1', 'review/PR 1'),
    tab('2', 'Shell'),
    tab('3', 'coding/api'),
    tab('4', 'review/PR 2', { agentStatus: 'blocked' }),
  ]
  const shape = (items: StripItem[]) =>
    items.map((it) =>
      it.kind === 'group' ? `[${it.group.name}]` : it.session.id,
    )

  it("gathers each group's tabs after its name, where its first tab is", () => {
    const items = stripItems(tabs, () => false, '2')
    expect(shape(items)).toEqual(['[review]', '1', '4', '2', '[coding]', '3'])
    const [review] = items
    expect(review).toMatchObject({
      kind: 'group',
      group: { name: 'review', agentStatus: 'blocked', collapsed: false },
    })
    expect(items[1]).toMatchObject({ kind: 'tab', group: 'review' })
    expect(items[3]).toMatchObject({ kind: 'tab' })
    expect(items[3]).not.toHaveProperty('group')
  })

  it('keys a tab by its lasting key, and a group apart from any tab', () => {
    const items = stripItems([tab('1', 'a/x', { key: 'k1' })], () => false, '1')
    expect(items.map((it) => it.key)).toEqual(['\0a', 'k1'])
  })

  it('shows only the tab on screen of a collapsed group', () => {
    const folded = (g: string) => g === 'review'
    expect(shape(stripItems(tabs, folded, '2'))).toEqual([
      '[review]',
      '2',
      '[coding]',
      '3',
    ])
    expect(shape(stripItems(tabs, folded, '4'))).toEqual([
      '[review]',
      '4',
      '2',
      '[coding]',
      '3',
    ])
  })
})

describe('dropGroup and dropTabIndex', () => {
  // [review] PR1 PR2 Shell [coding] api
  const items = stripItems(
    [
      tab('1', 'review/PR 1'),
      tab('2', 'review/PR 2'),
      tab('3', 'Shell'),
      tab('4', 'coding/api'),
    ],
    () => false,
    '3',
  )

  it('joins the group a tab lands inside', () => {
    // Shell after [review], and between PR 1 and PR 2
    expect(dropGroup(items, 3, 1)).toBe('review')
    expect(dropGroup(items, 3, 2)).toBe('review')
    // after [coding]
    expect(dropGroup(items, 3, 4)).toBe('coding')
  })

  it('leaves no group for a tab in none landing outside any', () => {
    expect(dropGroup(items, 3, 0)).toBeUndefined()
  })

  it('keeps its own group while one of its tabs is beside it', () => {
    // PR 1 after PR 2, the end of its group
    expect(dropGroup(items, 1, 2)).toBe('review')
  })

  it('leaves its own group away from its tabs', () => {
    expect(dropGroup(items, 1, 0)).toBeUndefined()
    // After Shell, before [coding]
    expect(dropGroup(items, 1, 3)).toBeUndefined()
    // api to the start
    expect(dropGroup(items, 5, 0)).toBeUndefined()
  })

  it('counts the tabs before where it lands', () => {
    expect(dropTabIndex(items, 3, 0)).toBe(0)
    expect(dropTabIndex(items, 3, 2)).toBe(1)
    expect(dropTabIndex(items, 1, 3)).toBe(2)
  })
})

describe('tabGroupMoveIndex', () => {
  const all = [
    tab('1', 'review/PR 1'),
    tab('2', 'Shell'),
    tab('3', 'review/PR 2'),
    tab('4', 'Logs'),
  ]
  // The bar: PR 1, PR 2, Shell, Logs
  const shown = [all[0], all[2], all[1], all[3]]

  it('is the place in a list without groups', () => {
    const plain = [tab('a', 'A'), tab('b', 'B'), tab('c', 'C')]
    expect(tabGroupMoveIndex(plain, plain, 'a', 2, undefined)).toBe(2)
    expect(tabGroupMoveIndex(plain, plain, 'c', 0, undefined)).toBe(0)
    expect(tabGroupMoveIndex(plain, plain, 'b', 1, undefined)).toBe(1)
  })

  it('lands next to a tab of its group, not one it is gathered away from', () => {
    // PR 1 after PR 2: after PR 2 among all, not before Shell
    expect(tabGroupMoveIndex(all, shown, '1', 1, 'review')).toBe(2)
    // Logs before PR 2, joining review
    expect(tabGroupMoveIndex(all, shown, '4', 1, 'review')).toBe(2)
  })

  it('lands before the tab that will follow it, else after the last', () => {
    expect(tabGroupMoveIndex(all, shown, '4', 0, undefined)).toBe(0)
    expect(tabGroupMoveIndex(all, shown, '2', 3, undefined)).toBe(3)
  })

  it('lands after the last tab of the group it joins at its end', () => {
    const list = [
      tab('1', 'review/PR 1'),
      tab('2', 'Shell'),
      tab('3', 'review/PR 2'),
      tab('4', 'Logs'),
    ]
    // The bar: PR 1, PR 2, Shell, Logs; Logs between PR 2 and Shell
    const bar = [list[0], list[2], list[1], list[3]]
    expect(tabGroupMoveIndex(list, bar, '4', 2, 'review')).toBe(3)
  })

  it('stays where it is alone', () => {
    const one = [tab('1', 'Shell')]
    expect(tabGroupMoveIndex(one, one, '1', 0, undefined)).toBe(0)
  })
})

describe('tabGroupNewName', () => {
  it('puts a new tab in the group of the tab on screen', () => {
    expect(tabGroupNewName('review/PR 1', 'PR 2')).toBe('review/PR 2')
  })

  it('keeps the name when the tab on screen is in none', () => {
    expect(tabGroupNewName('Shell', 'PR 2')).toBe('PR 2')
  })

  it('keeps a name that says its own group', () => {
    expect(tabGroupNewName('review/PR 1', 'coding/api')).toBe('coding/api')
  })
})

describe('tab group colours', () => {
  it('are the same for the same name', () => {
    expect(tabGroupFill('review')).toMatch(/^bg-avatar-[1-8]$/)
    expect(tabGroupFill('review')).toBe(tabGroupFill('review'))
    expect(tabGroupLine('review')).toBe(`after:${tabGroupFill('review')}`)
  })
})

describe('collapsed groups', () => {
  beforeEach(() => localStorage.clear())

  it('are kept by workspace and name', () => {
    expect(readCollapsed()).toEqual(new Set())
    writeCollapsed(
      new Set([collapsedKey('w', 'review'), collapsedKey(undefined, 'x')]),
    )
    expect(readCollapsed()).toEqual(new Set(['w\nreview', '\nx']))
    writeCollapsed(new Set())
    expect(localStorage.getItem('termote-tab-groups-collapsed')).toBeNull()
  })

  it('read nothing from what is not a list of names', () => {
    localStorage.setItem('termote-tab-groups-collapsed', '{"a":1}')
    expect(readCollapsed()).toEqual(new Set())
    localStorage.setItem('termote-tab-groups-collapsed', '["a",2]')
    expect(readCollapsed()).toEqual(new Set(['a']))
    localStorage.setItem('termote-tab-groups-collapsed', 'not json')
    expect(readCollapsed()).toEqual(new Set())
  })

  it('are kept nowhere without storage', () => {
    const set = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('full')
      })
    expect(() => writeCollapsed(new Set(['a']))).not.toThrow()
    set.mockRestore()
  })
})
