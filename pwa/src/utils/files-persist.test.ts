import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MuxSnapshot } from '../hooks/use-mux-api'
import {
  clearDrafts,
  DRAFT_LIMIT,
  DRAFTS_LIMIT,
  flushAll,
  loadDrafts,
  loadRecent,
  loadTabs,
  loadView,
  onDraftChangedElsewhere,
  onSignedOutElsewhere,
  onSignedOutHere,
  PERSIST_TTL,
  persistKey,
  RECENT_LIMIT,
  regroupPersisted,
  removeDraft,
  renamePersistedGroup,
  resetFilesPersist,
  SIGNED_OUT_KEY,
  saveRecent,
  saveTabs,
  saveView,
  signedOut,
  signOutPage,
  sweepExpired,
  TABS_DELAY,
  writeDraft,
} from './files-persist'
import { setFocusWindowForTest } from './focus-mode'
import { setPaneKeys } from './pane-remap'

// Server i1: tmux panes 1, 2 (keys @1, @2) in group main, Zellij-like pane
// z:1 (key z:1) in group z, and pane z (key z) in group z too
function snapshot(
  keys: [string, string][] = [
    ['1', '@1'],
    ['2', '@2'],
    ['z:1', 'z:1'],
    ['z', 'z'],
  ],
  instanceId = 'i1',
  groups = [
    { name: 'main', tabs: ['1', '2'] },
    { name: 'z', tabs: ['z:1', 'z'] },
  ],
) {
  setPaneKeys(
    {
      instanceId,
      groups: groups.map((g) => ({
        id: g.name,
        name: g.name,
        tabs: g.tabs.map((id) => ({ id, panes: [{ id: `${id}.p` }] })),
      })),
    } as unknown as MuxSnapshot,
    new Map(keys),
  )
}

const draft = (path: string, text = 'edited') => ({
  root: '/r',
  path,
  base: 'base',
  text,
})
const stored = (key: string) => JSON.parse(localStorage.getItem(key)!)

beforeEach(() => {
  vi.useFakeTimers()
  snapshot()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('persistKey', () => {
  it('is the instance and the pane key, null without a key', () => {
    expect(persistKey('files', '1')).toBe('termote-files-tabs:i1:@1')
    expect(persistKey('drafts', '1', 'a/b')).toBe(
      'termote-file-drafts:i1:@1:a/b',
    )
    expect(persistKey('view', 'nope')).toBeNull()
  })
})

describe('tabs', () => {
  it('are written once after the delay, the last state only', () => {
    saveTabs('files', '1', { n: 1 })
    saveTabs('files', '1', { n: 2 })
    expect(localStorage.getItem('termote-files-tabs:i1:@1')).toBeNull()
    // Read back before the write: the waiting state
    expect(loadTabs('files', '1')).toEqual({ n: 2 })
    vi.advanceTimersByTime(TABS_DELAY)
    const r = stored('termote-files-tabs:i1:@1')
    expect(r).toMatchObject({
      v: 1,
      pane: '@1',
      group: 'main',
      state: { n: 2 },
    })
    expect(r.savedAt).toBe(Date.now())
    expect(loadTabs('files', '1')).toEqual({ n: 2 })
  })

  it('keep the key of the pane they were saved for', () => {
    saveTabs('changes', '1', { n: 1 })
    // A tmux move: window 1 is now @2's
    snapshot([
      ['1', '@2'],
      ['2', '@1'],
    ])
    flushAll()
    expect(stored('termote-changes-tabs:i1:@1').state).toEqual({ n: 1 })
    expect(loadTabs('changes', '2')).toEqual({ n: 1 })
    expect(loadTabs('changes', '1')).toBeNull()
  })

  it('null removes them; a removal waiting reads as nothing', () => {
    saveTabs('files', '1', { n: 1 })
    flushAll()
    saveTabs('files', '1', null)
    expect(loadTabs('files', '1')).toBeNull()
    flushAll()
    expect(localStorage.getItem('termote-files-tabs:i1:@1')).toBeNull()
  })

  it('unchanged are written again only once a day', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    saveTabs('files', '1', { n: 1 })
    flushAll()
    saveTabs('files', '1', { n: 1 })
    flushAll()
    expect(setItem).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(24 * 60 * 60 * 1000)
    saveTabs('files', '1', { n: 1 })
    flushAll()
    expect(setItem).toHaveBeenCalledTimes(2)
  })

  it('of a pane without a key are not kept', () => {
    saveTabs('files', 'nope', { n: 1 })
    flushAll()
    expect(localStorage.length).toBe(0)
    expect(loadTabs('files', 'nope')).toBeNull()
  })

  it('of another group, another instance or another pane are not read', () => {
    saveTabs('files', '1', { n: 1 })
    flushAll()
    // @1 is now in another session (tmux restarted): removed
    snapshot([['1', '@1']], 'i1', [{ name: 'other', tabs: ['1'] }])
    expect(loadTabs('files', '1')).toBeNull()
    expect(localStorage.getItem('termote-files-tabs:i1:@1')).toBeNull()
    // Another server
    snapshot([['1', '@1']], 'i2')
    expect(persistKey('files', '1')).toBe('termote-files-tabs:i2:@1')
    // A record of pane z:1 under z's key prefix is not z's
    snapshot()
    localStorage.setItem(
      'termote-files-tabs:i1:z',
      JSON.stringify({ v: 1, pane: 'z:1', group: 'z', savedAt: 1, state: 1 }),
    )
    expect(loadTabs('files', 'z')).toBeNull()
  })

  it('that cannot be read are removed', () => {
    localStorage.setItem('termote-files-tabs:i1:@1', '{')
    expect(loadTabs('files', '1')).toBeNull()
    localStorage.setItem('termote-files-tabs:i1:@1', '{"v":2,"pane":"@1"}')
    expect(loadTabs('files', '1')).toBeNull()
    localStorage.setItem('termote-files-tabs:i1:@1', 'null')
    expect(loadTabs('files', '1')).toBeNull()
    expect(localStorage.getItem('termote-files-tabs:i1:@1')).toBeNull()
  })

  it('are flushed when the page is hidden or closes', () => {
    saveTabs('files', '1', { n: 1 })
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(localStorage.length).toBe(0)
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(loadTabs('files', '1')).toEqual({ n: 1 })
    saveTabs('files', '2', { n: 2 })
    window.dispatchEvent(new Event('pagehide'))
    expect(stored('termote-files-tabs:i1:@2').state).toEqual({ n: 2 })
  })
})

describe('drafts', () => {
  it('are written at once, one key each, and read back per pane', () => {
    expect(writeDraft('1', draft('a.md'), 5)).toBe(true)
    expect(writeDraft('1', draft('b.md'), 6)).toBe(true)
    expect(writeDraft('2', draft('c.md'), 7)).toBe(true)
    expect(stored('termote-file-drafts:i1:@1:a.md')).toMatchObject({
      v: 1,
      pane: '@1',
      group: 'main',
      role: 'full',
      editedAt: 5,
    })
    expect(loadDrafts('1')).toEqual([
      { draft: draft('a.md'), editedAt: 5 },
      { draft: draft('b.md'), editedAt: 6 },
    ])
    removeDraft('1', 'a.md')
    expect(loadDrafts<{ path: string }>('1').map((d) => d.draft.path)).toEqual([
      'b.md',
    ])
    removeDraft('nope', 'a.md')
    expect(loadDrafts('nope')).toEqual([])
    expect(writeDraft('nope', draft('a.md'), 1)).toBe(false)
  })

  it('of another pane whose key starts the same are not read', () => {
    writeDraft('z:1', draft('a'), 1)
    expect(loadDrafts('z')).toEqual([])
    // Not a draft record at all
    localStorage.setItem(
      'termote-file-drafts:i1:z:b',
      JSON.stringify({ v: 1, pane: 'z', group: 'z', editedAt: 'x' }),
    )
    expect(loadDrafts('z')).toEqual([])
  })

  it('over the limits are not written, and the older text goes', () => {
    expect(writeDraft('1', draft('a', 'x'), 1)).toBe(true)
    // JSON escapes count: a quote takes two characters
    expect(writeDraft('1', draft('a', '"'.repeat(DRAFT_LIMIT / 2)), 2)).toBe(
      false,
    )
    expect(localStorage.getItem('termote-file-drafts:i1:@1:a')).toBeNull()
    // Two drafts fit, a third would pass the total
    const third = 'x'.repeat(DRAFTS_LIMIT / 3)
    expect(writeDraft('1', draft('a', third), 1)).toBe(true)
    expect(writeDraft('1', draft('b', third), 1)).toBe(true)
    expect(writeDraft('2', draft('c', third), 1)).toBe(false)
    // The same draft written again is measured once
    expect(writeDraft('1', draft('b', third), 2)).toBe(true)
  })

  it('that storage refuses are not kept', () => {
    writeDraft('1', draft('a', 'old'), 1)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(writeDraft('1', draft('a', 'new'), 2)).toBe(false)
    expect(localStorage.getItem('termote-file-drafts:i1:@1:a')).toBeNull()
  })

  it('are all removed for a view-only client', () => {
    writeDraft('1', draft('a'), 1)
    writeDraft('2', draft('b'), 1)
    saveTabs('files', '1', { n: 1 })
    flushAll()
    clearDrafts()
    expect(Object.keys(localStorage)).toEqual(['termote-files-tabs:i1:@1'])
  })

  it('of other tabs count towards the total', () => {
    const big = 'x'.repeat(DRAFTS_LIMIT / 2)
    const key = 'termote-file-drafts:i1:@2:other'
    window.dispatchEvent(
      new StorageEvent('storage', { key, newValue: big + big }),
    )
    expect(writeDraft('1', draft('a', 'x'), 1)).toBe(false)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: null }))
    expect(writeDraft('1', draft('a', 'x'), 1)).toBe(true)
    // Not a draft, and a clear() of another tab (no key)
    window.dispatchEvent(new StorageEvent('storage', { key: 'x' }))
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
  })
})

describe('views', () => {
  it('are written at once and read back', () => {
    saveView('1', { view: 'files' })
    expect(loadView('1')).toEqual({ view: 'files' })
    expect(stored('termote-pane-view:i1:@1').savedAt).toBe(Date.now())
    saveView('1', null)
    expect(loadView('1')).toBeNull()
    saveView('nope', { view: 'files' })
    expect(localStorage.length).toBe(0)
  })
})

describe('files opened lately', () => {
  const file = (path: string) => ({ root: '/r', path })

  it('are written at once under the instance and pane key, and read back', () => {
    saveRecent('1', [file('a'), file('b')])
    expect(loadRecent('1')).toEqual([file('a'), file('b')])
    const r = stored('termote-recent-files:i1:@1')
    expect(r.savedAt).toBe(Date.now())
    expect(loadRecent('2')).toEqual([])
    saveRecent('1', [])
    expect(localStorage.getItem('termote-recent-files:i1:@1')).toBeNull()
    saveRecent('nope', [file('a')])
    expect(localStorage.length).toBe(0)
  })

  it('keep at most the limit, and only well formed entries', () => {
    const many = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) =>
      file(`f${i}`),
    )
    saveRecent('1', many)
    expect(loadRecent('1')).toHaveLength(RECENT_LIMIT)
    localStorage.setItem(
      'termote-recent-files:i1:@1',
      JSON.stringify({
        v: 1,
        pane: '@1',
        group: 'main',
        savedAt: Date.now(),
        files: [file('ok'), { root: 1, path: 'x' }, null, { root: '/r' }],
      }),
    )
    expect(loadRecent('1')).toEqual([file('ok')])
    localStorage.setItem(
      'termote-recent-files:i1:@1',
      JSON.stringify({ v: 1, pane: '@1', group: 'main', files: 'x' }),
    )
    expect(loadRecent('1')).toEqual([])
  })
})

describe('renamePersistedGroup', () => {
  it('moves the records of the renamed group to its new keys', () => {
    saveTabs('files', 'z:1', { n: 1 })
    writeDraft('z:1', draft('a:b'), 3)
    saveView('z', { view: 'chat' })
    saveView('1', { view: 'files' })
    renamePersistedGroup('z', 'y', 'y')
    expect(Object.keys(localStorage).sort()).toEqual([
      'termote-file-drafts:i1:y:1:a:b',
      'termote-files-tabs:i1:y:1',
      'termote-pane-view:i1:@1',
      'termote-pane-view:i1:y',
    ])
    expect(stored('termote-file-drafts:i1:y:1:a:b')).toMatchObject({
      pane: 'y:1',
      group: 'y',
      editedAt: 3,
    })
    // The renamed draft still counts towards the total
    snapshot([['y:1', 'y:1']], 'i1', [{ name: 'y', tabs: ['y:1'] }])
    const big = 'x'.repeat(DRAFTS_LIMIT - 100)
    expect(writeDraft('y:1', draft('other', big), 1)).toBe(false)
  })

  it('skips records it cannot read; a group gone has no name', () => {
    localStorage.setItem(
      'termote-pane-view:i1:z:9',
      JSON.stringify({ v: 1, pane: 'z:9', group: 'z', savedAt: 1 }),
    )
    localStorage.setItem('termote-pane-view:i1:bad', '{')
    renamePersistedGroup('z', 'y', null)
    expect(stored('termote-pane-view:i1:y:9').group).toBeNull()
  })
})

describe('signing out', () => {
  it('removes every record, writes nothing after, and tells other tabs', () => {
    localStorage.setItem('termote-settings', '{}')
    saveTabs('files', '1', { n: 1 })
    flushAll()
    writeDraft('1', draft('a'), 1)
    saveView('1', { view: 'files' })
    saveRecent('1', [{ root: '/r', path: 'a' }])
    // Waiting to be written when the user signs out
    saveTabs('changes', '1', { n: 2 })
    signedOut()
    expect(Object.keys(localStorage).sort()).toEqual([
      'termote-settings',
      SIGNED_OUT_KEY,
    ])
    vi.advanceTimersByTime(TABS_DELAY)
    window.dispatchEvent(new Event('pagehide'))
    flushAll()
    saveTabs('files', '1', { n: 3 })
    saveView('1', { view: 'files' })
    expect(writeDraft('1', draft('a'), 1)).toBe(false)
    renamePersistedGroup('z', 'y', 'y')
    expect(Object.keys(localStorage).sort()).toEqual([
      'termote-settings',
      SIGNED_OUT_KEY,
    ])
    expect(loadTabs('files', '1')).toBeNull()
    expect(loadView('1')).toBeNull()
    expect(loadDrafts('1')).toEqual([])
    saveRecent('1', [{ root: '/r', path: 'a' }])
    expect(loadRecent('1')).toEqual([])
  })

  it('in another tab stops this one and clears what it holds', () => {
    const fn = vi.fn()
    const off = onSignedOutElsewhere(fn)
    saveTabs('files', '1', { n: 1 })
    writeDraft('1', draft('a'), 1)
    // Only a value is a sign-out (not the key's removal)
    window.dispatchEvent(
      new StorageEvent('storage', { key: SIGNED_OUT_KEY, newValue: null }),
    )
    expect(fn).not.toHaveBeenCalled()
    window.dispatchEvent(
      new StorageEvent('storage', { key: SIGNED_OUT_KEY, newValue: '1' }),
    )
    expect(fn).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(TABS_DELAY)
    expect(localStorage.length).toBe(0)
    off()
  })

  it('from a page leaves for the sign-in page', () => {
    const assign = vi.fn()
    vi.spyOn(window, 'location', 'get').mockReturnValue({
      assign,
    } as unknown as Location)
    writeDraft('1', draft('a'), 1)
    signOutPage()
    expect(assign).toHaveBeenCalledWith('/login')
    expect(loadDrafts('1')).toEqual([])
  })

  it('without storage throws nothing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => signedOut()).not.toThrow()
  })
})

describe('sweepExpired', () => {
  it('removes old and broken records, a draft by when it was edited', () => {
    const now = Date.now()
    const old = now - PERSIST_TTL - 1
    const put = (key: string, r: object) =>
      localStorage.setItem(key, JSON.stringify({ v: 1, pane: '@1', ...r }))
    put('termote-files-tabs:i1:@1', { savedAt: old })
    put('termote-changes-tabs:i1:@1', { savedAt: now })
    put('termote-pane-view:i1:@1', {})
    put('termote-recent-files:i1:@1', { savedAt: old })
    put('termote-recent-files:i1:@2', { savedAt: now })
    // Written recently, edited long ago
    put('termote-file-drafts:i1:@1:a', { savedAt: now, editedAt: old })
    put('termote-file-drafts:i1:@1:b', { editedAt: now })
    localStorage.setItem('termote-file-drafts:i1:@1:c', '{')
    localStorage.setItem('termote-settings', '{}')
    sweepExpired(now)
    expect(Object.keys(localStorage).sort()).toEqual([
      'termote-changes-tabs:i1:@1',
      'termote-file-drafts:i1:@1:b',
      'termote-recent-files:i1:@2',
      'termote-settings',
    ])
  })

  it('measures the drafts it keeps', () => {
    const now = Date.now()
    localStorage.setItem(
      'termote-file-drafts:i1:@2:big',
      JSON.stringify({
        v: 1,
        pane: '@2',
        editedAt: now,
        pad: 'x'.repeat(DRAFTS_LIMIT - 50),
      }),
    )
    sweepExpired(now)
    expect(writeDraft('1', draft('a'), 1)).toBe(false)
  })
})

describe('without storage', () => {
  it('keeps nothing and throws nothing', () => {
    const denied = () => {
      throw new Error('denied')
    }
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(denied)
    saveTabs('files', '1', { n: 1 })
    flushAll()
    expect(loadTabs('files', '1')).toBeNull()
    expect(writeDraft('1', draft('a'), 1)).toBe(false)
    expect(loadDrafts('1')).toEqual([])
    removeDraft('1', 'a')
    saveView('1', { view: 'x' })
    expect(loadView('1')).toBeNull()
    expect(() => sweepExpired(Date.now())).not.toThrow()
  })

  it('that fails to read or list throws nothing', () => {
    writeDraft('1', draft('a'), 1)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(loadView('1')).toBeNull()
    removeDraft('1', 'a')
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(loadDrafts('1')).toEqual([])
  })
})

describe('resetFilesPersist', () => {
  it('without storage to read the sign-out from, still starts', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => resetFilesPersist()).not.toThrow()
  })

  it('starts over after a sign-out', () => {
    signedOut()
    resetFilesPersist()
    expect(writeDraft('1', draft('a'), 1)).toBe(true)
  })
})

describe('review follow-ups', () => {
  it('a draft of another group is left to expire, not removed', () => {
    writeDraft('1', draft('a'), 1)
    snapshot([['1', '@1']], 'i1', [{ name: 'renamed', tabs: ['1'] }])
    expect(loadDrafts('1')).toEqual([])
    expect(localStorage.getItem('termote-file-drafts:i1:@1:a')).not.toBeNull()
  })

  it('records of a group renamed elsewhere follow it', () => {
    saveTabs('files', '1', { n: 1 })
    writeDraft('1', draft('a'), 1)
    saveView('2', { view: 'chat' })
    saveView('z', { view: 'chat' })
    localStorage.setItem('termote-pane-view:i2:@1', '{"v":1,"pane":"@1"}')
    localStorage.setItem('termote-pane-view:i1:bad', '{')
    regroupPersisted(new Map())
    regroupPersisted(new Map([['@1', 'renamed']]))
    expect(stored('termote-files-tabs:i1:@1').group).toBe('renamed')
    expect(stored('termote-file-drafts:i1:@1:a').group).toBe('renamed')
    expect(stored('termote-pane-view:i1:@2').group).toBe('main')
    expect(stored('termote-pane-view:i2:@1').group).toBeUndefined()
    snapshot([['1', '@1']], 'i1', [{ name: 'renamed', tabs: ['1'] }])
    expect(loadDrafts('1')).toHaveLength(1)
    expect(loadTabs('files', '1')).toEqual({ n: 1 })
    // Nothing once signed out
    signedOut()
    regroupPersisted(new Map([['@1', 'x']]))
  })

  it('a Zellij rename leaves another server’s records', () => {
    localStorage.setItem(
      'termote-pane-view:i2:z:1',
      JSON.stringify({ v: 1, pane: 'z:1', group: 'z', savedAt: 1 }),
    )
    renamePersistedGroup('z', 'y', 'y')
    expect(localStorage.getItem('termote-pane-view:i2:z:1')).not.toBeNull()
  })

  it('a sign-out of another tab not yet told here stops the next write', () => {
    const fn = vi.fn()
    onSignedOutElsewhere(fn)
    // Another tab signed out: its storage event has not arrived
    localStorage.setItem(SIGNED_OUT_KEY, '42')
    expect(writeDraft('1', draft('a'), 1)).toBe(false)
    expect(fn).toHaveBeenCalledOnce()
    saveTabs('files', '1', { n: 1 })
    flushAll()
    expect(loadTabs('files', '1')).toBeNull()
  })

  it('tells this tab of its own sign-out, and of drafts other tabs change', () => {
    const here = vi.fn()
    const off = onSignedOutHere(here)
    const changed = vi.fn()
    const offChanged = onDraftChangedElsewhere(changed)
    const key = 'termote-file-drafts:i1:@1:a'
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: 'x' }))
    expect(changed).toHaveBeenCalledWith(key)
    offChanged()
    signedOut()
    expect(here).toHaveBeenCalledOnce()
    off()
  })
})

describe('a focus window', () => {
  // What the main window kept, as written before the focus window opened
  function keptByMain() {
    saveTabs('files', '1', { n: 1 })
    flushAll()
    writeDraft('1', draft('a.ts'), 5)
    saveView('1', { view: 'files' })
    saveRecent('1', [{ root: '/r', path: 'a.ts' }])
    return { ...localStorage }
  }

  it('reads nothing the main window kept', () => {
    keptByMain()
    setFocusWindowForTest(true)
    expect(loadTabs('files', '1')).toBeNull()
    expect(loadDrafts('1')).toEqual([])
    expect(loadView('1')).toBeNull()
    expect(loadRecent('1')).toEqual([])
  })

  it('writes, moves and removes nothing', () => {
    const before = keptByMain()
    saveTabs('changes', '1', { n: 1 })
    setFocusWindowForTest(true)
    // A tab change waiting from before is not read back either
    expect(loadTabs('changes', '1')).toBeNull()
    saveTabs('files', '1', { n: 2 })
    vi.advanceTimersByTime(TABS_DELAY)
    flushAll()
    expect(writeDraft('1', draft('b.ts'), 6)).toBe(false)
    removeDraft('1', 'a.ts')
    saveView('1', { view: 'chat' })
    saveView('1', null)
    saveRecent('1', [])
    renamePersistedGroup('main', 'other', 'other')
    regroupPersisted(new Map([['@1', 'renamed']]))
    const after = { ...localStorage }
    // The changes tabs saved before the focus flag were still waiting
    delete after['termote-changes-tabs:i1:@1']
    expect(after).toEqual(before)
  })

  it('sweeps nothing when the page loads', async () => {
    localStorage.setItem(
      'termote-pane-view:i1:@1',
      JSON.stringify({ v: 1, pane: '@1', group: 'main', savedAt: 0, view: 1 }),
    )
    window.location.hash = '#/overview?solo=1'
    vi.resetModules()
    try {
      await import('./files-persist')
      expect(localStorage.getItem('termote-pane-view:i1:@1')).not.toBeNull()
    } finally {
      window.location.hash = ''
    }
  })
})
