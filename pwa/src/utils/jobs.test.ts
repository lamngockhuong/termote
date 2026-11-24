import { describe, expect, it } from 'vitest'
import type { Job, JobGrant } from '../hooks/use-mux-api'
import { tFor } from '../i18n/i18n-context'
import {
  activeGrants,
  grantLabel,
  grantUsed,
  groupJobs,
  jobFinished,
  jobPaneRef,
  safePRUrl,
} from './jobs'
import { visibleUnsafe } from './unsafe-chars'

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  title: id,
  state: 'todo',
  updated: '2026-11-23T00:00:00Z',
  live: {},
  ...over,
})

const grant = (over: Partial<JobGrant> = {}): JobGrant => ({
  id: 'g',
  agent: { key: 'k', paneId: '%1', kind: 'claude' },
  kind: 'bash',
  prefix: 'pnpm test',
  created: '2026-11-23T00:00:00Z',
  expires: '2026-11-23T02:00:00Z',
  ...over,
})

describe('groupJobs', () => {
  it('splits the active jobs by what they need, then by state', () => {
    const jobs = [
      job('w', { state: 'active', live: { status: 'blocked' } }),
      job('u', { state: 'active', live: { status: 'idle', unread: true } }),
      job('r', { state: 'active', live: { status: 'working' } }),
      job('v', { state: 'review' }),
      job('t'),
      job('d', { state: 'done' }),
      job('f', { state: 'failed' }),
      job('a', { state: 'abandoned' }),
    ]
    const g = groupJobs(jobs)
    const ids = (list: Job[]) => list.map((j) => j.id)
    expect(ids(g.waiting)).toEqual(['w'])
    expect(ids(g.unread)).toEqual(['u'])
    expect(ids(g.running)).toEqual(['r'])
    expect(ids(g.review)).toEqual(['v'])
    expect(ids(g.todo)).toEqual(['t'])
    expect(ids(g.finished)).toEqual(['d', 'f', 'a'])
  })

  it('puts every unfinished job whose agent waits on a dialog first', () => {
    // An orchestrator moves a job to review while its agent still runs, and
    // the agent asks again: the dialog waits on the user all the same
    const blocked = { status: 'blocked' } as const
    const jobs = [
      job('v', { state: 'review', live: blocked }),
      job('t', { state: 'todo', live: blocked }),
      job('d', { state: 'done', live: blocked }),
    ]
    const g = groupJobs(jobs)
    expect(g.waiting.map((j) => j.id)).toEqual(['v', 't'])
    expect(g.review).toEqual([])
    expect(g.todo).toEqual([])
    expect(g.finished.map((j) => j.id)).toEqual(['d'])
  })

  it('knows the finished states', () => {
    expect(jobFinished('done')).toBe(true)
    expect(jobFinished('review')).toBe(false)
  })
})

describe('activeGrants', () => {
  it('keeps the grants neither revoked nor expired', () => {
    const now = Date.parse('2026-11-23T01:00:00Z')
    const kept = grant({ id: 'kept' })
    const j = job('x', {
      grants: [
        kept,
        grant({ id: 'revoked', revoked: '2026-11-23T00:30:00Z' }),
        grant({ id: 'expired', expires: '2026-11-23T00:59:00Z' }),
      ],
    })
    expect(activeGrants(j, now)).toEqual([kept])
    expect(activeGrants(job('none'), now)).toEqual([])
  })
})

describe('grantLabel', () => {
  const t = tFor('en')
  it('names what a grant covers, its prefix made visible', () => {
    expect(grantLabel(grant({ prefix: 'go‮test' }), t)).toBe(
      t('jobs.grant.runLabel', { prefix: visibleUnsafe('go\u202etest') }),
    )
    expect(grantLabel(grant({ prefix: undefined }), t)).toBe('Run: ')
    expect(grantLabel(grant({ kind: 'edit' }), t)).toBe(
      t('jobs.grant.editLabel'),
    )
    expect(grantLabel(grant({ kind: 'ci' }), t)).toBe(
      'Send failed checks to the agent',
    )
  })

  it('counts a ci grant in rounds', () => {
    const used = [{ at: 'x' }, { at: 'y' }]
    expect(grantUsed(grant({ kind: 'ci', uses: used }), t)).toBe(
      'sent 2 of 3 times',
    )
    expect(grantUsed(grant({ uses: used }), t)).toBe('used 2 times')
  })
})

describe('jobPaneRef', () => {
  it('names the pane as live has it, else as the job recorded it', () => {
    const agent = { key: 'k', paneId: '%9', kind: 'claude', ref: 'w:old' }
    expect(jobPaneRef(job('a', { live: { ref: 'w:t', paneId: '%1' } }))).toBe(
      'w:t',
    )
    expect(jobPaneRef(job('b', { live: { paneId: '%1' } }))).toBe('%1')
    expect(jobPaneRef(job('c', { agent }))).toBe('w:old')
    expect(jobPaneRef(job('d', { agent: { ...agent, ref: undefined } }))).toBe(
      '%9',
    )
    expect(jobPaneRef(job('e'))).toBe('')
  })
})

describe('safePRUrl', () => {
  it('keeps an https link to the pull request of that number and repo only', () => {
    const ok = 'https://github.com/o/r/pull/12'
    expect(safePRUrl(ok, 12, 'github.com/o/r')).toBe(ok)
    expect(
      safePRUrl('https://GitHub.com/O/r/pull/12', 12, 'github.com/o/r'),
    ).toBe('https://GitHub.com/O/r/pull/12')
    expect(
      safePRUrl('https://ghe.example/o/r/pull/7', 7, 'ghe.example/o/r'),
    ).toBe('https://ghe.example/o/r/pull/7')
    expect(
      safePRUrl('https://evil.example/o/r/pull/12', 12, 'github.com/o/r'),
    ).toBeUndefined()
    expect(
      safePRUrl('https://github.com/x/r/pull/12', 12, 'github.com/o/r'),
    ).toBeUndefined()
    for (const url of [
      undefined,
      '',
      'not a url',
      'javascript:alert(1)',
      'http://github.com/o/r/pull/12',
      'https://github.com/o/r/pull/13',
      'https://github.com/o/r/pull/012',
      'https://github.com/o/r/issues/12',
      'https://github.com/o/r/x/pull/12',
      'https://u:p@github.com/o/r/pull/12',
      'https://github.com/o/r/pull/12?x=1',
      'https://github.com/o/r/pull/12#x',
    ])
      expect(safePRUrl(url, 12, 'github.com/o/r')).toBeUndefined()
  })
})
