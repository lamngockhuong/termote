import { describe, expect, it } from 'vitest'
import type { Job, JobGrant } from '../hooks/use-mux-api'
import { tFor } from '../i18n/i18n-context'
import {
  activeGrants,
  grantLabel,
  grantUsed,
  groupJobs,
  jobDependents,
  jobFinished,
  jobPaneRef,
  jobsByWorkspace,
  jobsNeeding,
  jobWaits,
  jobWorkspace,
  safePRUrl,
  sortByPriority,
  sortTodo,
  workspaceName,
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

describe('priority and dependencies', () => {
  const ids = (jobs: Job[]) => jobs.map((j) => j.id)

  it('sorts by priority, keeping the order within one', () => {
    const jobs = [
      job('n1'),
      job('l1', { priority: 'low' }),
      job('h1', { priority: 'high' }),
      job('n2'),
      job('h2', { priority: 'high' }),
      job('l2', { priority: 'low' }),
    ]
    expect(ids(sortByPriority(jobs))).toEqual([
      'h1',
      'h2',
      'n1',
      'n2',
      'l1',
      'l2',
    ])
    // The list given stays as it was
    expect(jobs[0].id).toBe('n1')
  })

  it('puts the jobs to do that wait on nothing first, each part by priority', () => {
    const jobs = [
      job('w-high', { priority: 'high', waitsOn: ['x'] }),
      job('r-low', { priority: 'low' }),
      job('w-normal', { waitsOn: ['x'] }),
      job('r-normal', { waitsOn: [] }),
    ]
    expect(ids(sortTodo(jobs))).toEqual([
      'r-normal',
      'r-low',
      'w-high',
      'w-normal',
    ])
    expect(jobWaits(jobs[0])).toBe(1)
    expect(jobWaits(jobs[1])).toBe(0)
  })

  it('sorts the open columns, never the finished ones', () => {
    const g = groupJobs([
      job('d1', { state: 'done' }),
      job('d2', { state: 'done', priority: 'high' }),
      job('v1', { state: 'review' }),
      job('v2', { state: 'review', priority: 'high' }),
      job('t1', { waitsOn: ['v1'] }),
      job('t2', { priority: 'low' }),
      job('r1', { state: 'active' }),
      job('r2', { state: 'active', priority: 'high' }),
      job('u1', { state: 'active', live: { unread: true } }),
      job('u2', { state: 'active', priority: 'high', live: { unread: true } }),
      job('b1', { state: 'active', live: { status: 'blocked' } }),
      job('b2', {
        state: 'todo',
        priority: 'high',
        live: { status: 'blocked' },
      }),
    ])
    expect(ids(g.finished)).toEqual(['d1', 'd2'])
    expect(ids(g.review)).toEqual(['v2', 'v1'])
    expect(ids(g.todo)).toEqual(['t2', 't1'])
    expect(ids(g.running)).toEqual(['r2', 'r1'])
    expect(ids(g.unread)).toEqual(['u2', 'u1'])
    expect(ids(g.waiting)).toEqual(['b2', 'b1'])
  })

  it('finds the jobs that wait on one, however far round', () => {
    const jobs = [
      job('a'),
      job('b', { after: ['a'] }),
      job('c', { after: ['b'] }),
      job('d', { after: ['x'] }),
      // A cycle the file holds is walked once
      job('e', { after: ['f', 'a'] }),
      job('f', { after: ['e'] }),
    ]
    expect([...jobDependents('a', jobs)].sort()).toEqual(['b', 'c', 'e', 'f'])
    expect(jobDependents('d', jobs).size).toBe(0)
    expect(ids(jobsNeeding(jobs[0], jobs))).toEqual(['b', 'e'])
  })
})

describe('workspaces', () => {
  it('is the one the job is in now, else the one it was set to, else none', () => {
    expect(jobWorkspace(job('a'))).toBe('')
    expect(jobWorkspace(job('a', { workspace: 'w1' }))).toBe('w1')
    expect(
      jobWorkspace(job('a', { workspace: 'w1', workspaceNow: 'w2' })),
    ).toBe('w2')
  })

  it('is named by its group, else by its id', () => {
    const groups = [{ id: 'w1', name: 'acme\u202eapi' }]
    expect(workspaceName('w1', groups)).toBe(visibleUnsafe('acme\u202eapi'))
    expect(workspaceName('w9', groups)).toBe('w9')
    expect(workspaceName('w9')).toBe('w9')
  })

  it("splits the jobs by workspace: the groups' order, unknown ones, then none", () => {
    const jobs = [
      job('a'),
      job('b', { workspace: 'gone' }),
      job('c', { workspace: 'w2' }),
      job('d', { workspace: 'w1' }),
      job('e', { workspace: 'w2' }),
      job('f', { workspace: 'other' }),
    ]
    expect(
      jobsByWorkspace(jobs, ['w1', 'w2', 'w3']).map((w) => [
        w.workspace,
        w.jobs.map((j) => j.id),
      ]),
    ).toEqual([
      ['w1', ['d']],
      ['w2', ['c', 'e']],
      ['gone', ['b']],
      ['other', ['f']],
      ['', ['a']],
    ])
    expect(jobsByWorkspace([job('x', { workspace: 'w1' })])).toEqual([
      { workspace: 'w1', jobs: [job('x', { workspace: 'w1' })] },
    ])
    expect(jobsByWorkspace([])).toEqual([])
  })
})
