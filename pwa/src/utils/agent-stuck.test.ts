import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STUCK_MINUTES,
  resolveStuckMinutes,
  stuckFor,
} from './agent-stuck'

const NOW = Date.parse('2026-10-13T10:00:00Z')

describe('stuckFor', () => {
  it('flags a working agent quiet for the threshold, from that minute on', () => {
    expect(stuckFor('working', '2026-10-13T09:50:00Z', NOW, 10)).toBe(10)
    expect(stuckFor('working', '2026-10-13T09:46:00Z', NOW, 10)).toBe(14)
    expect(stuckFor('working', '2026-10-13T09:50:01Z', NOW, 10)).toBeUndefined()
  })
  it('never flags without a last write, a bad one, or another status', () => {
    expect(stuckFor('working', undefined, NOW, 10)).toBeUndefined()
    expect(stuckFor('working', 'nope', NOW, 10)).toBeUndefined()
    expect(stuckFor('blocked', '2026-10-13T08:00:00Z', NOW, 10)).toBeUndefined()
    expect(stuckFor(undefined, '2026-10-13T08:00:00Z', NOW, 10)).toBeUndefined()
  })
})

describe('resolveStuckMinutes', () => {
  it('keeps a value the Settings list offers, else the default', () => {
    expect(resolveStuckMinutes(3)).toBe(3)
    expect(resolveStuckMinutes(60)).toBe(60)
    for (const bad of [2, 7, 61, 7.5, '10', null, undefined]) {
      expect(resolveStuckMinutes(bad)).toBe(DEFAULT_STUCK_MINUTES)
    }
  })
})
