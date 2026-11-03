import { describe, expect, it } from 'vitest'
import { backendIsPaneStream } from './backend'

describe('backendIsPaneStream', () => {
  it('is Herdr and herdr-core only', () => {
    expect(backendIsPaneStream('herdr')).toBe(true)
    expect(backendIsPaneStream('hc')).toBe(true)
    for (const b of ['tmux', 'zellij', 'psmux', '', undefined]) {
      expect(backendIsPaneStream(b)).toBe(false)
    }
  })
})
