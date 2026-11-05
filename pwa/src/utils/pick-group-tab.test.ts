import { describe, expect, it } from 'vitest'
import { pickGroupTab } from './pick-group-tab'

describe('pickGroupTab', () => {
  const tabs = ['a', 'b', 'c']

  it('opens the tab last shown on this device', () => {
    expect(pickGroupTab(tabs, 'c', 'b')).toBe('c')
  })

  it("opens the server's current tab when none was shown here", () => {
    expect(pickGroupTab(tabs, undefined, 'b')).toBe('b')
  })

  it('passes over a tab that has been closed', () => {
    expect(pickGroupTab(tabs, 'gone', 'b')).toBe('b')
    expect(pickGroupTab(tabs, 'gone', 'also-gone')).toBe('a')
  })

  it('opens the first tab with nothing else to go by', () => {
    expect(pickGroupTab(tabs)).toBe('a')
  })

  it('has nothing to open in a group without tabs', () => {
    expect(pickGroupTab([], 'a', 'b')).toBeUndefined()
  })
})
