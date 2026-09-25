import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSIONS,
  SESSIONS_STORAGE_KEY,
  toAgentStatus,
  worstAgentStatus,
} from './session'

describe('SESSIONS_STORAGE_KEY', () => {
  it('exports the correct storage key string', () => {
    expect(SESSIONS_STORAGE_KEY).toBe('termote-sessions')
  })
})

describe('DEFAULT_SESSIONS', () => {
  it('is an array with at least one session', () => {
    expect(Array.isArray(DEFAULT_SESSIONS)).toBe(true)
    expect(DEFAULT_SESSIONS.length).toBeGreaterThan(0)
  })

  it('first session is shell with correct shape', () => {
    const shell = DEFAULT_SESSIONS[0]
    expect(shell.id).toBe('shell')
    expect(shell.name).toBe('Shell')
    expect(shell.icon).toBe('💻')
    expect(shell.description).toBe('Terminal')
  })

  it('all sessions have required fields', () => {
    for (const session of DEFAULT_SESSIONS) {
      expect(typeof session.id).toBe('string')
      expect(typeof session.name).toBe('string')
      expect(typeof session.icon).toBe('string')
      expect(typeof session.description).toBe('string')
    }
  })
})

describe('toAgentStatus', () => {
  it('keeps statuses that have a badge', () => {
    expect(toAgentStatus('working')).toBe('working')
    expect(toAgentStatus('blocked')).toBe('blocked')
  })

  it('drops unknown, unexpected and missing values', () => {
    expect(toAgentStatus('unknown')).toBeUndefined()
    expect(toAgentStatus('thinking')).toBeUndefined()
    expect(toAgentStatus(undefined)).toBeUndefined()
  })
})

describe('worstAgentStatus', () => {
  it('orders blocked > working > done > idle', () => {
    expect(worstAgentStatus(['idle', 'done', 'working', 'blocked'])).toBe(
      'blocked',
    )
    expect(worstAgentStatus(['idle', 'working', 'done'])).toBe('working')
    expect(worstAgentStatus(['idle', undefined, 'done'])).toBe('done')
    expect(worstAgentStatus(['idle'])).toBe('idle')
  })

  it('is undefined when nothing has a badge', () => {
    expect(worstAgentStatus([])).toBeUndefined()
    expect(worstAgentStatus([undefined])).toBeUndefined()
  })
})
