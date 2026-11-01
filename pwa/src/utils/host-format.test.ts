import { describe, expect, it } from 'vitest'
import { tFor } from '../i18n/i18n-context'
import {
  batteryLevel,
  formatBytes,
  formatMinutes,
  historySlots,
  hostLevel,
  hostPercent,
  peak,
} from './host-format'

describe('host-format', () => {
  it('levels CPU and memory at 80 and 95', () => {
    expect(hostLevel(79.9)).toBe('normal')
    expect(hostLevel(80)).toBe('warning')
    expect(hostLevel(95)).toBe('danger')
  })

  it('levels a battery only while it drains', () => {
    const b = {
      percent: 15,
      charging: false,
      plugged: false,
      minutesLeft: null,
    }
    expect(batteryLevel(b)).toBe('warning')
    expect(batteryLevel({ ...b, percent: 10 })).toBe('danger')
    expect(batteryLevel({ ...b, percent: 50 })).toBe('normal')
    expect(batteryLevel({ ...b, percent: 5, plugged: true })).toBe('normal')
    expect(batteryLevel({ ...b, percent: 5, charging: true })).toBe('normal')
  })

  it('formats bytes in GB and MB', () => {
    expect(formatBytes(16 * 1024 ** 3)).toBe('16 GB')
    expect(formatBytes(9.84 * 1024 ** 3)).toBe('9.8 GB')
    expect(formatBytes(120.4 * 1024 ** 3)).toBe('120 GB')
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB')
  })

  it('formats minutes', () => {
    const t = tFor('en')
    expect(formatMinutes(65, t)).toBe('1 h 05 min')
    expect(formatMinutes(45, t)).toBe('45 min')
    expect(formatMinutes(120, t)).toBe('2 h')
  })

  it('formats percents and peaks', () => {
    expect(hostPercent(61.4)).toBe('61%')
    expect(hostPercent(37.5, true)).toBe('~38%')
    expect(peak([null, 3, 9, null, 4])).toBe(9)
    expect(peak([null])).toBeUndefined()
  })
})

describe('historySlots', () => {
  it('lays points out by time, gaps and old points left out', () => {
    const at = (s: number) =>
      new Date(Date.UTC(2026, 10, 1, 0, 0, s)).toISOString()
    const history = [
      { t: at(-100), cpu: 1, mem: 1 }, // older than 3 slots: dropped
      { t: at(0), cpu: 5, mem: 6 },
      { t: at(10), cpu: 7, mem: null },
    ]
    expect(historySlots(history, (p) => p.cpu, at(10), 3)).toEqual([5, null, 7])
    expect(historySlots(history, (p) => p.mem, at(10), 3)).toEqual([
      6,
      null,
      null,
    ])
    expect(historySlots(history, (p) => p.cpu, 'bad', 2)).toEqual([null, null])
    const bad = [{ t: 'soon', cpu: 1, mem: 1 }]
    expect(historySlots(bad, (p) => p.cpu, at(10), 2)).toEqual([null, null])
  })
})
