import { describe, expect, it } from 'vitest'
import tableJson from '../../../server/delegate_programs.json?raw'
import casesJson from '../../../server/testdata/grant-prefix-cases.json?raw'
import {
  type DelegateProgram,
  grantPrefixProblem,
  MAX_GRANT_PREFIX,
  PROGRAMS,
  TOOLS,
} from './grant-prefix'

const sorted = (a: readonly string[] = []) => [...a].sort()

describe('the table', () => {
  it("is the server's, word for word (order aside)", () => {
    const table = JSON.parse(tableJson) as {
      tools: string[]
      programs: Record<string, DelegateProgram>
    }
    expect(sorted(TOOLS)).toEqual(sorted(table.tools))
    expect(sorted(Object.keys(PROGRAMS))).toEqual(
      sorted(Object.keys(table.programs)),
    )
    for (const [name, p] of Object.entries(table.programs)) {
      const mine = PROGRAMS[name]
      expect(sorted(mine.commands), name).toEqual(sorted(p.commands))
      expect(sorted(mine.script), name).toEqual(sorted(p.script))
      expect(sorted(mine.bare), name).toEqual(sorted(p.bare))
      expect(!!mine.toolchain, name).toBe(!!p.toolchain)
      expect(sorted(mine.switches), name).toEqual(sorted(p.switches))
      expect(sorted(mine.valueOptions), name).toEqual(sorted(p.valueOptions))
    }
  })
})

describe('grantPrefixProblem', () => {
  // The server's TestGrantPrefixCases runs the same file: both refuse the
  // same prefixes for the same reason.
  it('agrees with the server on every shared case', () => {
    const cases = JSON.parse(casesJson) as { prefix: string; want: string }[]
    expect(cases.length).toBeGreaterThan(100)
    for (const c of cases)
      expect(grantPrefixProblem(c.prefix), JSON.stringify(c.prefix)).toBe(
        c.want === '' ? null : c.want,
      )
  })

  it('trims what the server trims', () => {
    expect(grantPrefixProblem(' cargo test ')).toBeNull()
  })

  it('wants something typed', () => {
    expect(grantPrefixProblem('')).toBe('empty')
    expect(grantPrefixProblem('   ')).toBe('empty')
  })

  it('refuses a prefix longer than the server takes', () => {
    const long = (n: number) => `rg ${'a'.repeat(n - 3)}`
    expect(grantPrefixProblem(long(MAX_GRANT_PREFIX))).toBeNull()
    expect(grantPrefixProblem(long(MAX_GRANT_PREFIX + 1))).toBe('length')
  })

  it('refuses a character outside printable ASCII', () => {
    for (const p of ['a\u200bb', 'pnpm test\u001b[2J', 'rg \u00e9'])
      expect(grantPrefixProblem(p), p).toBe('chars')
  })

  it('takes a name inherited from Object as no program', () => {
    for (const p of ['constructor test', '__proto__ test', 'toString'])
      expect(grantPrefixProblem(p), p).toBe('program')
  })
})
