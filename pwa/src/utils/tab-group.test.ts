import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import {
  collapsedKey,
  dropGroup,
  dropWant,
  groupMoveOrder,
  joinTabGroup,
  moveSteps,
  nearestMove,
  newTabName,
  readCollapsed,
  type StripItem,
  solveTabMove,
  splitTabGroup,
  stepWant,
  stripItems,
  stripUnits,
  tabGroupFill,
  tabGroupLine,
  tabGroupNewName,
  validGroupName,
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

describe('newTabName', () => {
  const names = ['shell', '1', 'review/PR 1', 'review/1', 'review/2']

  it('keeps a name the user typed', () => {
    expect(newTabName(' vim ', names, true)).toBe('vim')
    expect(newTabName('review/PR 3', names, false)).toBe('review/PR 3')
  })

  it('leaves it to the backend without a group', () => {
    expect(newTabName('', names, false)).toBe('')
    expect(newTabName('  ', names, false)).toBe('')
  })

  it('numbers it for tmux, after the numbers taken outside any group', () => {
    expect(newTabName('', names, true)).toBe('2')
    expect(newTabName('', [], true)).toBe('1')
  })

  it('numbers it in a group, from that group only', () => {
    expect(newTabName('review/', names, false)).toBe('review/3')
    expect(newTabName(' logs / ', names, true)).toBe('logs/1')
  })

  it('keeps a path-like or bare separator as a plain name', () => {
    expect(newTabName('~/', names, false)).toBe('~/')
    expect(newTabName('/', names, true)).toBe('/')
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

describe('dropGroup', () => {
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
})

// The bar's tabs as [group]id, a group none of whose tabs shows as [group]
const bar = (items: StripItem[]) =>
  items
    .flatMap((it) =>
      it.kind === 'tab'
        ? [`${it.group ? `${it.group}:` : ''}${it.session.id}`]
        : it.group.collapsed
          ? [`[${it.group.name}]`]
          : [],
    )
    .join(' ')
const moved = (all: Session[], m: { id: string; index: number } | null) => {
  if (!m) return all
  const list = all.filter((s) => s.id !== m.id)
  list.splice(m.index, 0, all.find((s) => s.id === m.id)!)
  return list
}

describe('stepWant and solveTabMove', () => {
  const lay =
    (folded: string[] = [], active = '') =>
    (list: readonly Session[]) =>
      stripItems(list, (g) => folded.includes(g), active)
  // The bar after a step of id, the move found applied (rename first)
  const step = (
    all: Session[],
    id: string,
    delta: -1 | 1,
    folded: string[] = [],
  ) => {
    const layOut = lay(folded)
    const items = layOut(all)
    const at = items.findIndex(
      (it) => it.kind === 'tab' && it.session.id === id,
    )
    const want = stepWant(items, at, delta)
    if (!want) return undefined
    const group = (
      want.find((it) => it.kind === 'tab' && it.session.id === id) as {
        group?: string
      }
    ).group
    const named = all.map((s) =>
      s.id === id
        ? { ...s, name: joinTabGroup(group, splitTabGroup(s.name).label) }
        : s,
    )
    const m = solveTabMove(named, want, layOut, id)
    return m === undefined ? 'stuck' : bar(layOut(moved(named, m)))
  }

  it("swaps a group's first tab with the next, its tabs scattered on the server", () => {
    // The bar: [review] A B Shell
    const all = [tab('A', 'review/A'), tab('S', 'Shell'), tab('B', 'review/B')]
    expect(step(all, 'A', 1)).toBe('review:B review:A S')
    expect(step(all, 'B', -1)).toBe('review:B review:A S')
  })

  it('keeps another group in its place moving the first tab of one', () => {
    const all = [
      tab('x', 'g/x'),
      tab('p', 'h/p'),
      tab('y', 'g/y'),
      tab('q', 'h/q'),
    ]
    expect(step(all, 'x', 1)).toBe('g:y g:x h:p h:q')
  })

  it("takes a tab out of its group at the group's edge", () => {
    const all = [tab('a', 'a'), tab('x', 'g/x'), tab('y', 'g/y'), tab('b', 'b')]
    expect(step(all, 'x', -1)).toBe('a x g:y b')
    expect(step(all, 'y', 1)).toBe('a g:x y b')
  })

  it('moves a tab in no group past a whole group', () => {
    const all = [tab('a', 'a'), tab('x', 'g/x'), tab('y', 'g/y'), tab('b', 'b')]
    expect(step(all, 'b', -1)).toBe('a b g:x g:y')
    expect(step(all, 'a', 1)).toBe('g:x g:y a b')
    // Scattered: past the group, not past b too
    const scattered = [
      tab('a', 'a'),
      tab('x', 'g/x'),
      tab('b', 'b'),
      tab('y', 'g/y'),
    ]
    expect(step(scattered, 'a', 1)).toBe('g:x g:y a b')
    // A collapsed group is one step too
    expect(step(all, 'a', 1, ['g'])).toBe('[g] a b')
  })

  it('swaps two tabs in no group, and stops at either end', () => {
    const all = [tab('a', 'a'), tab('b', 'b')]
    expect(step(all, 'a', 1)).toBe('b a')
    expect(step(all, 'a', -1)).toBeUndefined()
    expect(step(all, 'b', 1)).toBeUndefined()
  })

  it('needs no move when the bar already shows it', () => {
    const all = [tab('a', 'a'), tab('b', 'b')]
    const items = lay()(all)
    expect(solveTabMove(all, items, lay(), 'a')).toBeNull()
  })

  it('says when no single move shows it', () => {
    const all = [tab('a', 'a'), tab('b', 'b'), tab('c', 'c')]
    const items = lay()(all)
    // c b a: two moves at least
    const want = [items[2], items[1], items[0]]
    expect(solveTabMove(all, want, lay(), 'a')).toBeUndefined()
  })

  it("drops a group's first tab out of it without moving the group", () => {
    // The bar: [review] A B Shell; A dragged to the start
    const all = [tab('A', 'review/A'), tab('S', 'Shell'), tab('B', 'review/B')]
    const items = lay()(all)
    const want = dropWant(items, 1, 0, undefined)
    const named = all.map((s) => (s.id === 'A' ? { ...s, name: 'A' } : s))
    const m = solveTabMove(named, want, lay(), 'A')
    expect(bar(lay()(moved(named, m!)))).toBe('A review:B S')
  })
})

describe('nearestMove', () => {
  const all = [tab('a', 'a'), tab('b', 'b'), tab('c', 'c')]
  const want = (ids: string[]) =>
    ids.map(
      (id) =>
        ({
          kind: 'tab',
          key: id,
          session: all.find((s) => s.id === id)!,
        }) as StripItem,
    )

  it('puts the tab before the one that follows it', () => {
    expect(nearestMove(all, want(['b', 'a', 'c']), 'a')).toEqual({
      id: 'a',
      index: 1,
    })
    expect(nearestMove(all, want(['c', 'a', 'b']), 'c')).toEqual({
      id: 'c',
      index: 0,
    })
  })

  it('puts the last tab after the one before it', () => {
    expect(nearestMove(all, want(['b', 'c', 'a']), 'a')).toEqual({
      id: 'a',
      index: 2,
    })
    // A group's name in the bar is no tab
    const chip = {
      kind: 'group',
      key: '\0g',
      group: { name: 'g' },
    } as StripItem
    expect(
      nearestMove(all, [...want(['a']), chip, ...want(['c'])], 'c'),
    ).toEqual({
      id: 'c',
      index: 1,
    })
  })

  it('puts the last tab after one further on the server', () => {
    expect(nearestMove(all, want(['c', 'a']), 'a')).toEqual({
      id: 'a',
      index: 2,
    })
  })

  it('moves nothing already in place, or alone', () => {
    expect(nearestMove(all, want(['a', 'b', 'c']), 'b')).toBeNull()
    expect(nearestMove([all[0]], want(['a']), 'a')).toBeNull()
  })
})

describe('moving a whole group', () => {
  const all = [
    tab('x', 'g/x'),
    tab('a', 'a'),
    tab('p', 'h/p'),
    tab('y', 'g/y'),
    tab('q', 'h/q', { key: 'kq' }),
  ]
  // The bar: [g] x y, a, [h] p q
  const items = stripItems(all, () => false, 'a')

  it('splits the bar into units: a tab in none, or a group with its tabs', () => {
    expect(
      stripUnits(items).map((u) =>
        u
          .map((it) =>
            it.kind === 'group' ? `[${it.group.name}]` : it.session.id,
          )
          .join(' '),
      ),
    ).toEqual(['[g] x y', 'a', '[h] p q'])
  })

  it("puts a group's tabs together before the unit that follows it", () => {
    const ids = (list: Session[]) => list.map((s) => s.id).join(' ')
    const units = stripUnits(items)
    // g before [h]: before p, h's first tab
    expect(ids(groupMoveOrder(all, 'g', units[2][0]))).toBe('a x y p q')
    // h before a
    expect(ids(groupMoveOrder(all, 'h', units[1][0]))).toBe('x p q a y')
    // g at the end
    expect(ids(groupMoveOrder(all, 'g'))).toBe('a p q x y')
  })

  it('moves one tab at a time, each by its lasting key', () => {
    const to = groupMoveOrder(all, 'h', stripUnits(items)[0][0])
    const steps = moveSteps(all, to)
    expect(steps).toEqual([
      { key: 'p', index: 0 },
      { key: 'kq', index: 1 },
    ])
    expect(moveSteps(all, all)).toEqual([])
  })
})

describe('validGroupName', () => {
  it('refuses what would not split back into the group', () => {
    expect(validGroupName('review')).toBe(true)
    expect(validGroupName('')).toBe(false)
    expect(validGroupName('a/b')).toBe(false)
    expect(validGroupName('~')).toBe(false)
    expect(validGroupName('..')).toBe(false)
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
