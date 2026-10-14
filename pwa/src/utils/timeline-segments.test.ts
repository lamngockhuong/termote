import { describe, expect, it } from 'vitest'
import type { ActivityEvent } from '../hooks/use-mux-api'
import {
  segmentTotals,
  TIMELINE_WINDOW,
  timelineSegments,
} from './timeline-segments'

const NOW = Date.parse('2026-10-13T10:00:00Z')
const min = (n: number) => n * 60_000
let seq = 0
const ev = (
  key: string,
  agoMin: number,
  from: string,
  to: string,
  paneId = key,
): ActivityEvent => ({
  seq: ++seq,
  ts: new Date(NOW - min(agoMin)).toISOString(),
  key,
  groupId: 'g',
  tabId: 't',
  paneId,
  agent: 'claude',
  from,
  to,
})

describe('timelineSegments', () => {
  it('is empty without events for the key', () => {
    expect(timelineSegments([], 'k', NOW)).toEqual([])
    expect(timelineSegments([ev('other', 5, '', 'working')], 'k', NOW)).toEqual(
      [],
    )
  })

  it('cuts the hour by the statuses, leaving the time before them blank', () => {
    const s = timelineSegments(
      [
        ev('k', 30, '', 'working'),
        ev('k', 10, 'working', 'blocked'),
        ev('k', 4, 'blocked', 'working'),
      ],
      'k',
      NOW,
    )
    expect(s).toEqual([
      { status: 'working', start: NOW - min(30), end: NOW - min(10) },
      { status: 'blocked', start: NOW - min(10), end: NOW - min(4) },
      { status: 'working', start: NOW - min(4), end: NOW },
    ])
    expect(segmentTotals(s)).toEqual([
      ['working', min(24)],
      ['blocked', min(6)],
    ])
  })

  it('clips an event before the window to its start, drops one wholly before', () => {
    const s = timelineSegments(
      [
        ev('k', 180, '', 'idle'),
        ev('k', 90, 'idle', 'working'),
        ev('k', 20, 'working', 'done'),
      ],
      'k',
      NOW,
    )
    expect(s).toEqual([
      { status: 'working', start: NOW - TIMELINE_WINDOW, end: NOW - min(20) },
      { status: 'done', start: NOW - min(20), end: NOW },
    ])
  })

  it('leaves the time after the agent went blank, and joins a repeat', () => {
    const s = timelineSegments(
      [
        ev('k', 50, '', 'working'),
        ev('k', 40, 'working', 'working'),
        ev('k', 30, 'working', ''),
        ev('k', 5, '', 'idle'),
      ],
      'k',
      NOW,
    )
    expect(s).toEqual([
      { status: 'working', start: NOW - min(50), end: NOW - min(30) },
      { status: 'idle', start: NOW - min(5), end: NOW },
    ])
  })

  it('follows the key when the ids change (a moved window, a renamed session)', () => {
    const s = timelineSegments(
      [
        ev('@7', 20, '', 'working', '2'),
        // the window moved: same key, another id
        ev('@7', 10, 'working', 'done', '5'),
        // a closed window's id taken by another window
        ev('@9', 8, '', 'blocked', '2'),
      ],
      '@7',
      NOW,
    )
    expect(s.map((x) => x.status)).toEqual(['working', 'done'])
  })

  it('skips an event with a bad time', () => {
    const bad = { ...ev('k', 5, '', 'working'), ts: 'nope' }
    expect(timelineSegments([bad], 'k', NOW)).toEqual([])
  })
})
