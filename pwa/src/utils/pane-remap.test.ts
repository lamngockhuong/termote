import { describe, expect, it, vi } from 'vitest'
import type { MuxSnapshot } from '../hooks/use-mux-api'
import {
  destination,
  onPaneRemap,
  paneKeys,
  remapEntries,
  remapPanes,
  shiftedIds,
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
