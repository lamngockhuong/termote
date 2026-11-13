import { afterEach, describe, expect, it } from 'vitest'
import {
  registerTerminalProbe,
  type TerminalProbe,
  visibleLines,
} from './terminal-probe'

type ProbeWindow = { __termoteE2E?: boolean; __termoteTerms?: TerminalProbe[] }
const w = window as unknown as ProbeWindow

function probe(): TerminalProbe {
  return {
    paneId: () => '%1',
    lines: () => [],
    webgl: () => false,
    write: async () => {},
  }
}

afterEach(() => {
  delete w.__termoteE2E
  delete w.__termoteTerms
})

describe('registerTerminalProbe', () => {
  it('attaches nothing without the test flag', () => {
    const remove = registerTerminalProbe(probe())
    expect(w.__termoteTerms).toBeUndefined()
    remove()
    expect(w.__termoteTerms).toBeUndefined()
  })

  it('attaches nothing when the flag is not exactly true', () => {
    ;(w as { __termoteE2E?: unknown }).__termoteE2E = 'yes'
    registerTerminalProbe(probe())
    expect(w.__termoteTerms).toBeUndefined()
  })

  it('adds and removes each probe with the flag', () => {
    w.__termoteE2E = true
    const a = probe()
    const b = probe()
    const removeA = registerTerminalProbe(a)
    const removeB = registerTerminalProbe(b)
    expect(w.__termoteTerms).toEqual([a, b])
    removeA()
    expect(w.__termoteTerms).toEqual([b])
    // Removing twice leaves the others
    removeA()
    expect(w.__termoteTerms).toEqual([b])
    removeB()
    expect(w.__termoteTerms).toEqual([])
  })
})

describe('visibleLines', () => {
  it('reads the rows from the viewport down, blank where a line is missing', () => {
    const lines = ['old', 'one', 'two']
    const term = {
      rows: 3,
      buffer: {
        active: {
          viewportY: 1,
          getLine: (y: number) =>
            y < lines.length
              ? {
                  translateToString: (trim: boolean) =>
                    trim ? lines[y] : `${lines[y]}  `,
                }
              : undefined,
        },
      },
    }
    expect(visibleLines(term)).toEqual(['one', 'two', ''])
  })
})
