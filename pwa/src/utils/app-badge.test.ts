import { afterEach, describe, expect, it, vi } from 'vitest'
import badgeFixture from '../../../server/testdata/badge-snapshot.json'
import { buildSessions } from '../hooks/use-local-sessions'
import type { MuxSnapshot } from '../hooks/use-mux-api'
import type { Session } from '../types/session'
import {
  applyBadge,
  BADGE_URL,
  badgeCount,
  badgeSupported,
  clearBadge,
  writeBadgePref,
} from './app-badge'

// navigator with the Badging API, recording each call
function stubBadge(fail = false) {
  const set = vi.fn(async (_n?: number) => {
    if (fail) throw new Error('refused')
  })
  const clear = vi.fn(async () => {
    if (fail) throw new Error('refused')
  })
  Object.defineProperty(navigator, 'setAppBadge', {
    configurable: true,
    value: set,
  })
  Object.defineProperty(navigator, 'clearAppBadge', {
    configurable: true,
    value: clear,
  })
  return { set, clear }
}

function unstubBadge() {
  Reflect.deleteProperty(navigator, 'setAppBadge')
  Reflect.deleteProperty(navigator, 'clearAppBadge')
}

const tab = (s: Partial<Session>): Session => ({
  id: 'x',
  name: 'x',
  icon: '',
  description: '',
  ...s,
})

describe('badgeCount', () => {
  it('counts each blocked or done pane once', () => {
    const sessions = [
      // A tab's own status is its heaviest pane's: its panes count instead
      tab({
        agentStatus: 'blocked',
        panes: [
          { id: 'a', label: 'a', hasAgent: true, agentStatus: 'blocked' },
          { id: 'b', label: 'b', hasAgent: true, agentStatus: 'done' },
          { id: 'c', label: 'c', hasAgent: true, agentStatus: 'working' },
          { id: 'd', label: 'd', hasAgent: true, agentStatus: 'idle' },
          { id: 'e', label: 'e', hasAgent: false },
        ],
      }),
      // No panes listed: the tab's own status
      tab({ agentStatus: 'done' }),
      tab({ agentStatus: 'idle', panes: [] }),
      tab({}),
    ]
    expect(badgeCount(sessions)).toBe(3)
    expect(badgeCount([])).toBe(0)
  })

  // The worker counts the same snapshot (src/sw/notify-sw.test.ts)
  it('counts the shared snapshot fixture as the server does', () => {
    const built = buildSessions(
      badgeFixture.snapshot as unknown as MuxSnapshot,
      {},
      (k) => k,
    )
    expect(badgeCount(built.sessions)).toBe(badgeFixture.expected)
  })
})

describe('applyBadge', () => {
  afterEach(unstubBadge)

  it('does nothing without the Badging API', () => {
    unstubBadge()
    expect(badgeSupported()).toBe(false)
    expect(() => applyBadge(3)).not.toThrow()
    expect(() => clearBadge()).not.toThrow()
  })

  it('sets the count, and clears it at 0', () => {
    const { set, clear } = stubBadge()
    expect(badgeSupported()).toBe(true)
    applyBadge(2)
    expect(set).toHaveBeenCalledWith(2)
    applyBadge(0)
    clearBadge()
    expect(clear).toHaveBeenCalledTimes(2)
  })

  it('ignores a refusal', async () => {
    const { set, clear } = stubBadge(true)
    applyBadge(1)
    applyBadge(0)
    await Promise.resolve()
    expect(set).toHaveBeenCalled()
    expect(clear).toHaveBeenCalled()
  })
})

describe('writeBadgePref', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the setting where the worker reads it', async () => {
    const stored = new Map<string, Response>()
    const open = vi.fn(async () => ({
      put: async (url: string, res: Response) => {
        stored.set(url, res)
      },
    }))
    vi.stubGlobal('caches', { open })
    await writeBadgePref(false)
    expect(open).toHaveBeenCalledWith('termote-prefs')
    expect(await stored.get(BADGE_URL)?.text()).toBe('0')
    await writeBadgePref(true)
    expect(await stored.get('/__badge')?.text()).toBe('1')
  })

  it('without Cache Storage, or refused, does nothing', async () => {
    vi.stubGlobal('caches', undefined)
    await expect(writeBadgePref(true)).resolves.toBeUndefined()
    vi.stubGlobal('caches', {
      open: async () => {
        throw new Error('denied')
      },
    })
    await expect(writeBadgePref(true)).resolves.toBeUndefined()
  })
})
