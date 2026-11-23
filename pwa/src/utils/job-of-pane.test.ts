import { describe, expect, it } from 'vitest'
import type { Job } from '../hooks/use-mux-api'
import { jobOfPane } from './job-of-pane'

const job = (
  id: string,
  pane: string | undefined,
  status: Job['live']['status'],
  updated = '2026-11-23T09:00:00Z',
  state: Job['state'] = 'active',
): Job => ({
  id,
  title: id,
  state,
  updated,
  live: { status, paneId: pane },
})

describe('jobOfPane', () => {
  it('takes the active jobs whose agent is still in its pane', () => {
    const got = jobOfPane([
      job('working', '%1', 'working'),
      job('blocked', '%2', 'blocked'),
      job('background', '%3', 'background'),
      job('idle', '%4', 'idle'),
      job('gone', '%5', 'gone'),
      job('unknown', '%6', 'unknown'),
      job('none', '%7', undefined),
      job('no pane', undefined, 'working'),
      job('review', '%8', 'idle', undefined, 'review'),
      job('done', '%9', 'idle', undefined, 'done'),
    ])
    expect(Object.fromEntries([...got].map(([p, j]) => [p, j.id]))).toEqual({
      '%1': 'working',
      '%2': 'blocked',
      '%3': 'background',
      '%4': 'idle',
    })
  })

  it('gives a pane two jobs share to the one changed last', () => {
    const older = job('older', '%1', 'working', '2026-11-23T08:00:00Z')
    const newer = job('newer', '%1', 'working', '2026-11-23T09:00:00Z')
    expect(jobOfPane([older, newer]).get('%1')?.id).toBe('newer')
    expect(jobOfPane([newer, older]).get('%1')?.id).toBe('newer')
  })
})
