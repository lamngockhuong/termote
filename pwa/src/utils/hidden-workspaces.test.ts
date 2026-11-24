import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionGroup } from '../types/session'
import {
  closeHiddenNotifications,
  HIDDEN_URL,
  hiddenGroupIds,
  hiddenKey,
  renameHiddenKey,
  resolveHiddenKeys,
  visibleGroups,
  visibleSessions,
  writeHiddenForWorker,
} from './hidden-workspaces'
import { LOCALE_CACHE } from './notify-locale'

const M = '0123456789abcdef'

describe('hiddenKey', () => {
  it('joins the machine and the trimmed name', () => {
    expect(hiddenKey('', ' web ')).toBe('\u0000web')
    expect(hiddenKey(M, 'web')).toBe(`${M}\u0000web`)
    expect(hiddenKey('', 'web')).not.toBe(hiddenKey(M, 'web'))
  })

  it('keeps every other character of the name as it is', () => {
    expect(hiddenKey('', 'a​b‮')).toBe('\u0000a​b‮')
    const long = 'x'.repeat(100)
    expect(hiddenKey('', long)).toBe(`\u0000${long}`)
  })
})

describe('resolveHiddenKeys', () => {
  it('keeps the strings of an array, once each', () => {
    expect(resolveHiddenKeys(['a', 1, 'b', 'a', null])).toEqual(['a', 'b'])
  })

  it('reads anything else as none', () => {
    expect(resolveHiddenKeys(null)).toEqual([])
    expect(resolveHiddenKeys({ a: 1 })).toEqual([])
    expect(resolveHiddenKeys('a')).toEqual([])
  })
})

const groups: SessionGroup[] = [
  { id: '$1', name: 'api' },
  { id: '$2', name: 'web', worktree: { linked: false } },
  { id: '$3', name: 'web-fix', worktree: { linked: true, parent: '$2' } },
  { id: '$4', name: 'docs' },
]

describe('hiddenGroupIds', () => {
  it('is empty without keys', () => {
    expect(hiddenGroupIds(groups, [], '').size).toBe(0)
  })

  it('hides the groups whose key is listed, on this machine only', () => {
    const keys = [hiddenKey('', 'api'), hiddenKey(M, 'docs')]
    expect([...hiddenGroupIds(groups, keys, '')]).toEqual(['$1'])
    expect([...hiddenGroupIds(groups, keys, M)]).toEqual(['$4'])
  })

  it("hides a hidden checkout's linked worktrees with it", () => {
    const ids = hiddenGroupIds(groups, [hiddenKey('', 'web')], '')
    expect([...ids].sort()).toEqual(['$2', '$3'])
  })
})

describe('visibleGroups and visibleSessions', () => {
  const sessions: Session[] = [
    { id: 't1', name: 'a', icon: '', description: '', groupId: '$1' },
    { id: 't2', name: 'b', icon: '', description: '', groupId: '$2' },
    { id: 't3', name: 'c', icon: '', description: '' },
  ]

  it('returns the same lists when nothing is hidden', () => {
    expect(visibleGroups(groups, new Set())).toBe(groups)
    expect(visibleSessions(sessions, new Set())).toBe(sessions)
  })

  it('drops the hidden ones, in order', () => {
    const hidden = new Set(['$1', '$3'])
    expect(visibleGroups(groups, hidden).map((g) => g.id)).toEqual(['$2', '$4'])
    expect(visibleSessions(sessions, hidden).map((s) => s.id)).toEqual([
      't2',
      't3',
    ])
  })
})

describe('renameHiddenKey', () => {
  const keys = [hiddenKey('', 'old'), hiddenKey(M, 'old')]

  it("moves the machine's key to the new name", () => {
    expect(renameHiddenKey(keys, '', 'old', 'new')).toEqual([
      hiddenKey('', 'new'),
      hiddenKey(M, 'old'),
    ])
  })

  it('merges with the new name when it is hidden too', () => {
    const both = [hiddenKey('', 'old'), hiddenKey('', 'new')]
    expect(renameHiddenKey(both, '', 'old', 'new')).toEqual([
      hiddenKey('', 'new'),
    ])
  })

  it('leaves a name that is not hidden, or the same name, alone', () => {
    expect(renameHiddenKey(keys, '', 'x', 'y')).toEqual(keys)
    expect(renameHiddenKey(keys, '', 'old', ' old ')).toEqual(keys)
  })
})

describe('writeHiddenForWorker', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps the keys in the prefs cache', async () => {
    const put = vi.fn().mockResolvedValue(undefined)
    const open = vi.fn().mockResolvedValue({ put })
    vi.stubGlobal('caches', { open })
    await writeHiddenForWorker(['a'])
    expect(open).toHaveBeenCalledWith(LOCALE_CACHE)
    expect(put.mock.calls[0][0]).toBe(HIDDEN_URL)
    expect(await (put.mock.calls[0][1] as Response).json()).toEqual(['a'])
  })

  it('does nothing without Cache Storage, or when it is refused', async () => {
    vi.stubGlobal('caches', undefined)
    await expect(writeHiddenForWorker(['a'])).resolves.toBeUndefined()
    vi.stubGlobal('caches', { open: vi.fn().mockRejectedValue(new Error()) })
    await expect(writeHiddenForWorker(['a'])).resolves.toBeUndefined()
  })
})

describe('closeHiddenNotifications', () => {
  afterEach(() => vi.unstubAllGlobals())

  function note(data: unknown) {
    return { data, close: vi.fn() }
  }

  function stubNotes(notes: Array<ReturnType<typeof note>>) {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({
          getNotifications: vi.fn().mockResolvedValue(notes),
        }),
      },
    })
  }

  it("closes the hidden group's notifications on its machine", async () => {
    const page = note({ hash: '#/s/%241/%241%3A2/%253' })
    const pushed = note({ hash: '#/s/%241/%241%3A2/%253', machine: M })
    const other = note({ hash: '#/s/%242/%242%3A1' })
    const elsewhere = note({
      hash: '#/s/%241/%241%3A1',
      machine: 'f'.repeat(16),
    })
    const job = note({ job: 'abc' })
    const empty = note(null)
    stubNotes([page, pushed, other, elsewhere, job, empty])
    await closeHiddenNotifications('$1', M)
    expect(page.close).toHaveBeenCalled()
    expect(pushed.close).toHaveBeenCalled()
    expect(other.close).not.toHaveBeenCalled()
    expect(elsewhere.close).not.toHaveBeenCalled()
    expect(job.close).not.toHaveBeenCalled()
    expect(empty.close).not.toHaveBeenCalled()
  })

  it('does nothing without a worker, or when reading fails', async () => {
    vi.stubGlobal('navigator', {})
    await expect(closeHiddenNotifications('$1', '')).resolves.toBeUndefined()
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistration: vi.fn().mockResolvedValue(undefined) },
    })
    await expect(closeHiddenNotifications('$1', '')).resolves.toBeUndefined()
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockRejectedValue(new Error('no')),
      },
    })
    await expect(closeHiddenNotifications('$1', '')).resolves.toBeUndefined()
  })
})
