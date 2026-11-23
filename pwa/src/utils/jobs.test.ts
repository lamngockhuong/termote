import { describe, expect, it } from 'vitest'
import type { Job, JobGrant } from '../hooks/use-mux-api'
import { tFor } from '../i18n/i18n-context'
import {
  activeGrants,
  grantLabel,
  groupJobs,
  jobFinished,
  jobPaneRef,
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
