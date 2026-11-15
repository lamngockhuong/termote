import { describe, expect, it } from 'vitest'
import { tFor } from '../i18n/i18n-context'
import { sessionAge } from './session-age'

const t = tFor('en')
const now = Date.parse('2026-11-14T12:00:00Z')

describe('sessionAge', () => {
  it('says minutes, hours, then days', () => {
    expect(sessionAge('2026-11-14T11:59:30Z', now, t)).toBe('just now')
    expect(sessionAge('2026-11-14T11:30:00Z', now, t)).toBe('30 min ago')
    expect(sessionAge('2026-11-14T02:00:00Z', now, t)).toBe('10 h ago')
    expect(sessionAge('2026-11-11T12:00:00Z', now, t)).toBe('3 d ago')
    // A clock ahead of this device's is now
    expect(sessionAge('2026-11-14T12:05:00Z', now, t)).toBe('just now')
    expect(sessionAge('not a time', now, t)).toBe('')
  })
})
