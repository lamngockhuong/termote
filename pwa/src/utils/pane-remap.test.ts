import { describe, expect, it, vi } from 'vitest'
import type { MuxSnapshot } from '../hooks/use-mux-api'
import {
  destination,
  onPaneRemap,
  paneGroupOf,
  paneInstance,
  paneKeyOf,
  paneKeys,
  remapEntries,
  remapPanes,
  renamedGroupId,
  renameGroupKeys,
  resetPaneKeys,
  sessionPaneKey,
  setPaneKeys,
  shiftedIds,
  tabPaneMoves,
} from './pane-remap'

const keys = (...pairs: [string, string][]) => new Map(pairs)

describe('shiftedIds', () => {
  it('a tmux move of 3 to the top shifts the run it passes', () => {
    // 1=a 2=b 3=c → 1=c 2=a 3=b
    const s = shiftedIds(
      keys(['1', '@a'], ['2', '@b'], ['3', '@c']),
      keys(['1', '@c'], ['2', '@a'], ['3', '@b']),
    )
    expect([...s.moved]).toEqual([
      ['1', '2'],
      ['2', '3'],
      ['3', '1'],
    ])
    expect([...s.stale].sort()).toEqual(['1', '2', '3'])
  })

  it('a close under renumber-windows shifts the windows after it', () => {
    const s = shiftedIds(
      keys(['0', '@a'], ['1', '@b'], ['2', '@c']),
      keys(['0', '@a'], ['1', '@c']),
    )
    expect([...s.moved]).toEqual([['2', '1']])
    expect([...s.stale].sort()).toEqual(['1', '2'])
    expect(destination(s, '1')).toBeNull()
    expect(destination(s, '2')).toBe('1')
    expect(destination(s, '0')).toBe('0')
  })

  it('Herdr: keys are ids, nothing shifts; a closed tab is stale', () => {
    const prev = keys(['w1:t1', 'w1:t1'], ['w1:p1', 'w1:p1'])
    expect(shiftedIds(prev, prev).stale.size).toBe(0)
    const s = shiftedIds(prev, keys(['w1:t1', 'w1:t1']))
    expect([...s.stale]).toEqual(['w1:p1'])
    expect(s.moved.size).toBe(0)
  })

  it('two windows trading places', () => {
    const s = shiftedIds(
      keys(['1', '@a'], ['2', '@b']),
      keys(['1', '@b'], ['2', '@a']),
    )
    expect([...s.moved]).toEqual([
      ['1', '2'],
      ['2', '1'],
    ])
  })
})

describe('Zellij', () => {
  it("reused tab ids: a new tab never takes a closed tab's state", () => {
    // Tab 1 closed, a new tab got its id: its key (its first terminal) differs
    const s = shiftedIds(
      keys(['zA:t1', 'zA/terminal_2'], ['zA:p2', 'zA:p2']),
      keys(['zA:t1', 'zA/terminal_5'], ['zA:p5', 'zA:p5']),
    )
    expect(destination(s, 'zA:t1')).toBeNull()
    expect(destination(s, 'zA:p2')).toBeNull()
  })

  it('two sessions whose first tabs are both terminal_0 stay apart', () => {
    const prev = keys(
      ['zA:t0', 'zA/terminal_0'],
      ['zA:p0', 'zA:p0'],
      ['zB:t0', 'zB/terminal_0'],
      ['zB:p0', 'zB:p0'],
    )
    expect(shiftedIds(prev, prev).stale.size).toBe(0)
  })

  it('a session rename moves every id of that session, by prefix', () => {
    const prev = keys(
      ['zA:t0', 'zA/terminal_0'],
      ['zA:p0', 'zA:p0'],
      ['zA:p3', 'zA:p3'],
      ['zAB:t0', 'zAB/terminal_0'],
      ['zAB:p0', 'zAB:p0'],
    )
    const next = keys(
      ['zN:t0', 'zN/terminal_0'],
      ['zN:p0', 'zN:p0'],
      ['zN:p3', 'zN:p3'],
      ['zAB:t0', 'zAB/terminal_0'],
      ['zAB:p0', 'zAB:p0'],
    )
    // Without the rename the old ids are only gone
    expect(shiftedIds(prev, next).moved.size).toBe(0)
    const s = shiftedIds(renameGroupKeys(prev, 'zA', 'zN'), next)
    expect([...s.moved]).toEqual([
      ['zA:t0', 'zN:t0'],
      ['zA:p0', 'zN:p0'],
      ['zA:p3', 'zN:p3'],
    ])
    // A session whose id only starts with the same letters is left alone
    expect(destination(s, 'zAB:t0')).toBe('zAB:t0')
    expect(destination(s, 'zAB:p0')).toBe('zAB:p0')
  })
})

describe('paneKeys', () => {
  it('keys tabs by their key, panes with the tab id by the tab key', () => {
    const snap = {
      groups: [
        {
          id: 'main',
          name: 'main',
          tabs: [
            {
              id: '1',
              key: '@4',
              name: 'a',
              active: true,
              panes: [{ id: '1', active: true }],
            },
            {
              id: '2',
              name: 'b',
              active: false,
              panes: [{ id: 'w:p2', active: true }],
            },
          ],
        },
      ],
    } as unknown as MuxSnapshot
    expect([...paneKeys(snap)]).toEqual([
      ['1', '@4'],
      ['2', '2'],
      ['w:p2', 'w:p2'],
    ])
    expect(paneKeys({} as MuxSnapshot).size).toBe(0)
  })
})

describe('remapEntries', () => {
  it('moves a chain at once, drops what now names another pane', () => {
    const s = shiftedIds(
      keys(['1', '@a'], ['2', '@b'], ['3', '@c']),
      keys(['2', '@a'], ['3', '@b'], ['1', '@x']),
    )
    const map = new Map([
      ['1', 'A'],
      ['2', 'B'],
      ['3', 'C'],
      ['9', 'Z'],
    ])
    remapEntries(map, s)
    expect([...map].sort()).toEqual([
      ['2', 'A'],
      ['3', 'B'],
      ['9', 'Z'],
    ])
  })

  it('keeps the rest of a composite key', () => {
    const s = shiftedIds(keys(['1', '@a']), keys(['4', '@a']))
    const map = new Map([['1\u0000x.txt', 'draft']])
    remapEntries(
      map,
      s,
      (k) => k.split('\u0000')[0],
      (k, id) => id + k.slice(k.indexOf('\u0000')),
    )
    expect([...map]).toEqual([['4\u0000x.txt', 'draft']])
  })
})

describe('remapPanes', () => {
  it('tells every handler of a shift, none of no shift', () => {
    const fn = vi.fn()
    const off = onPaneRemap(fn)
    remapPanes({ moved: new Map(), stale: new Set() })
    expect(fn).not.toHaveBeenCalled()
    const shift = { moved: new Map([['1', '2']]), stale: new Set(['1', '2']) }
    remapPanes(shift)
    expect(fn).toHaveBeenCalledWith(shift)
    off()
    remapPanes(shift)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('renamedGroupId', () => {
  it('moves the group, its tabs, panes and keys, nothing else', () => {
    expect(renamedGroupId('zA', 'zA', 'zN')).toBe('zN')
    expect(renamedGroupId('zA:p1', 'zA', 'zN')).toBe('zN:p1')
    expect(renamedGroupId('zA/terminal_0', 'zA', 'zN')).toBe('zN/terminal_0')
    expect(renamedGroupId('zAB:p1', 'zA', 'zN')).toBe('zAB:p1')
    expect(renamedGroupId('%3', 'zA', 'zN')).toBe('%3')
  })
})

describe('sessionPaneKey', () => {
  it("is the tab's key for its own pane, the pane id for any other", () => {
    expect(sessionPaneKey({ id: '2', key: '@7' }, '2')).toBe('@7')
    expect(sessionPaneKey({ id: '2' }, '2')).toBe('2')
    expect(sessionPaneKey({ id: 'w:t1', key: 'w:t1' }, 'w:p3')).toBe('w:p3')
  })
})

describe('setPaneKeys', () => {
  const snap = (instanceId?: string, groups?: object[]) =>
    ({ instanceId, groups }) as unknown as MuxSnapshot

  it('names each pane by its key, instance and group', () => {
    setPaneKeys(
      snap('i1', [
        {
          id: '$0',
          name: 'main',
          tabs: [{ id: '1', key: '@1', panes: [{ id: '1' }, { id: '%5' }] }],
        },
      ]),
      new Map([
        ['1', '@1'],
        ['%5', '%5'],
      ]),
    )
    expect(paneInstance()).toBe('i1')
    expect(paneKeyOf('1')).toBe('@1')
    expect(paneKeyOf('%5')).toBe('%5')
    expect(paneKeyOf('0')).toBeNull()
    expect(paneGroupOf('%5')).toBe('main')
    expect(paneGroupOf('0')).toBeNull()
    resetPaneKeys()
    expect(paneInstance()).toBeNull()
    expect(paneKeyOf('1')).toBeNull()
    expect(paneGroupOf('1')).toBeNull()
  })

  it('gives no key without an instance id (an older server)', () => {
    setPaneKeys(snap(undefined, undefined), new Map([['1', '@1']]))
    expect(paneInstance()).toBeNull()
    expect(paneKeyOf('1')).toBeNull()
  })
})

describe('setPaneKeys renames', () => {
  const snap = (instanceId: string, name: string) =>
    ({
      instanceId,
      groups: [{ id: '$0', name, tabs: [{ id: '1', panes: [{ id: '%5' }] }] }],
    }) as unknown as MuxSnapshot
  const keys = new Map([
    ['1', '@1'],
    ['%5', '%5'],
  ])

  it('names the panes whose group was renamed, on the same server', () => {
    resetPaneKeys()
    expect(setPaneKeys(snap('i1', 'a'), keys).size).toBe(0)
    expect(setPaneKeys(snap('i1', 'a'), keys).size).toBe(0)
    expect([...setPaneKeys(snap('i1', 'b'), keys)]).toEqual([
      ['@1', 'b'],
      ['%5', 'b'],
    ])
    // Another server: nothing is renamed
    expect(setPaneKeys(snap('i2', 'c'), keys).size).toBe(0)
    // An older server (no instance id): nothing either
    setPaneKeys(snap('i2', 'c'), keys)
    expect(
      setPaneKeys({ groups: [] } as unknown as MuxSnapshot, keys).size,
    ).toBe(0)
    setPaneKeys(snap('i2', 'c'), keys)
    // A pane gone from its group (not listed) has no name
    expect([
      ...setPaneKeys(
        { instanceId: 'i2', groups: [] } as unknown as MuxSnapshot,
        keys,
      ),
    ]).toEqual([
      ['@1', null],
      ['%5', null],
    ])
    resetPaneKeys()
  })
})

describe('tabPaneMoves', () => {
  const snap = (backend: string, clientSideSelect = false) =>
    ({
      backend,
      caps: { clientSideSelect },
      groups: [
        {
          id: 'main',
          tabs: [
            {
              id: '0',
              key: '@1',
              panes: [
                { id: '%3', active: false },
                { id: '%4', active: true },
              ],
            },
            { id: '1', key: '@2', panes: [{ id: '%5', active: false }] },
            // psmux, or a tab still known by its own id
            { id: '2', key: '2', panes: [{ id: '2', active: true }] },
            { id: '3', panes: [{ id: '%7', active: true }] },
            { id: '4', key: '@4', panes: [] },
          ],
        },
      ],
    }) as unknown as MuxSnapshot

  it("gives each tmux tab's id and key its active pane", () => {
    const { ids, keys } = tabPaneMoves(snap('tmux'))
    expect([...ids]).toEqual([
      ['0', '%4'],
      ['1', '%5'],
      ['3', '%7'],
    ])
    expect([...keys]).toEqual([
      ['@1', '%4'],
      ['@2', '%5'],
    ])
  })

  it('moves nothing on another backend', () => {
    for (const s of [snap('herdr', true), snap('zellij', true)]) {
      const { ids, keys } = tabPaneMoves(s)
      expect(ids.size + keys.size).toBe(0)
    }
    const noGroups = { ...snap('tmux'), groups: undefined }
    expect(tabPaneMoves(noGroups as unknown as MuxSnapshot).ids.size).toBe(0)
  })
})
