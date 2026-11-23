import { describe, expect, it } from 'vitest'
import type { JobPR } from '../hooks/use-mux-api'
import { tFor } from '../i18n/i18n-context'
import {
  CI_WORST_TONE,
  CI_WORST_WORDS,
  ciErrorWords,
  ciFailKey,
  ciSetNumbers,
  parsePRNumber,
  prChecksTone,
  prChecksWords,
  prStateWords,
} from './job-ci'

const pr = (over: Partial<JobPR>): JobPR => ({
  number: 1,
  repo: 'github.com/o/r',
  state: 'open',
  ...over,
})

describe('job-ci', () => {
  it('names and colours every worst state', () => {
    const t = tFor('en')
    for (const w of ['fail', 'pending', 'open', 'draft', 'merged'] as const) {
      expect(t(CI_WORST_WORDS[w])).not.toBe(CI_WORST_WORDS[w])
      expect(CI_WORST_TONE[w]).toMatch(/text-/)
    }
    expect(CI_WORST_TONE.fail).toContain('danger')
  })

  it('reads a failed read and a pull request', () => {
    expect(ciErrorWords('ci_gh_auth')).toBe('errors.ci_gh_auth')
    expect(ciErrorWords('something_new')).toBe('errors.ci_failed')
    expect(prStateWords(pr({ state: 'merged' }))).toBe('jobs.ci.state.merged')
    expect(prStateWords(pr({ state: 'closed' }))).toBe('jobs.ci.state.closed')
    expect(prStateWords(pr({ draft: true }))).toBe('jobs.ci.state.draft')
    expect(prStateWords(pr({}))).toBe('jobs.ci.state.open')
    expect(prChecksWords(pr({ checks: 'fail' }))).toBe('jobs.ci.checks.fail')
    expect(prChecksWords(pr({ state: 'merged', checks: 'fail' }))).toBe(
      undefined,
    )
    expect(prChecksTone(pr({ checks: 'fail' }))).toBe('text-danger')
    expect(prChecksTone(pr({ checks: 'pending' }))).toBe('text-warning')
    expect(prChecksTone(pr({ checks: 'pass' }))).toBe('text-success')
    expect(prChecksTone(pr({ state: 'closed', checks: 'pass' }))).toBe(
      'text-fg-muted',
    )
  })

  it('keys the failing set as the server does, foreign ones as asked', () => {
    expect(
      ciFailKey([
        pr({ number: 15, checks: 'fail', head: 'b' }),
        pr({ number: 12, checks: 'fail', head: 'a' }),
        pr({ number: 9, checks: 'pass', head: 'c' }),
        pr({ number: 7, checks: 'fail', head: 'd', foreign: true }),
      ]),
    ).toBe('fail:12@a,15@b,7@d')
    expect(
      ciFailKey(
        [
          pr({ number: 12, checks: 'fail', head: 'a' }),
          pr({ number: 7, checks: 'fail', head: 'd', foreign: true }),
        ],
        false,
      ),
    ).toBe('fail:12@a')
    expect(ciFailKey([pr({ checks: 'pass' })])).toBe('')
    expect(ciSetNumbers('12@abc,15@def')).toBe('#12, #15')
    expect(ciSetNumbers('fail:3@x')).toBe('#3')
  })

  it('reads a typed pull request number', () => {
    expect(parsePRNumber(' #42 ')).toBe(42)
    expect(parsePRNumber('7')).toBe(7)
    for (const bad of ['', '0', '-1', '1.5', 'x', '12345678901', '#'])
      expect(parsePRNumber(bad)).toBe(null)
  })
})
