import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  adoptChatDrafts,
  clearChatDrafts,
  clearChatDraftsOnSignOut,
  isTextInsert,
  loadDraft,
  onDraftInsert,
  remapChatDrafts,
  requestDraftInsert,
  saveDraft,
  takeDraftInsert,
} from './chat-draft'
import { resetFilesPersist, SIGNED_OUT_KEY, signedOut } from './files-persist'

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('chat drafts', () => {
  it('are kept per pane; an empty one is removed', () => {
    saveDraft('%1', 'hi')
    expect(loadDraft('%1')).toBe('hi')
    saveDraft('%1', '')
    expect(sessionStorage.getItem('termote-chat-draft:%1')).toBeNull()
  })

  it('follow their pane when ids shift, all at once', () => {
    saveDraft('1', 'a')
    saveDraft('2', 'b')
    saveDraft('3', 'c')
    saveDraft('9', 'z')
    // 1 → 2, 2 → 1 (traded); 3 gone; 4 (no draft) → 5
    remapChatDrafts({
      moved: new Map([
        ['1', '2'],
        ['2', '1'],
        ['4', '5'],
      ]),
      stale: new Set(['1', '2', '3', '4', '5']),
    })
    expect(loadDraft('5')).toBe('')
    expect([
      loadDraft('1'),
      loadDraft('2'),
      loadDraft('3'),
      loadDraft('9'),
    ]).toEqual(['b', 'a', '', 'z'])
  })

  it('without storage, nothing is kept and nothing throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    saveDraft('%1', 'x')
    expect(loadDraft('%1')).toBe('')
  })
})

describe('commands asked for a composer', () => {
  it('wait per pane until taken, once, and tell the listeners', () => {
    const fn = vi.fn()
    const off = onDraftInsert(fn)
    const c = { name: 'compact', source: 'builtin' as const }
    requestDraftInsert('%1', c)
    expect(fn).toHaveBeenCalledOnce()
    expect(takeDraftInsert('%2')).toBeUndefined()
    expect(takeDraftInsert('%1')).toBe(c)
    expect(takeDraftInsert('%1')).toBeUndefined()
    off()
    requestDraftInsert('%1', c)
    expect(fn).toHaveBeenCalledOnce()
    takeDraftInsert('%1')
    // Focus only: no command
    requestDraftInsert('%1')
    expect(takeDraftInsert('%1')).toBeNull()
  })
})

describe('signing out', () => {
  beforeEach(() => clearChatDraftsOnSignOut())
  afterEach(() => resetFilesPersist())

  it('clears every draft of this tab and what waits for one', () => {
    saveDraft('1', 'a')
    saveDraft('2', 'b')
    sessionStorage.setItem('other', 'kept')
    requestDraftInsert('1')
    signedOut()
    expect(loadDraft('1')).toBe('')
    expect(loadDraft('2')).toBe('')
    expect(sessionStorage.getItem('other')).toBe('kept')
    expect(takeDraftInsert('1')).toBeUndefined()
  })

  it('in another tab clears them too', () => {
    saveDraft('1', 'a')
    window.dispatchEvent(
      new StorageEvent('storage', { key: SIGNED_OUT_KEY, newValue: '1' }),
    )
    expect(loadDraft('1')).toBe('')
  })

  it('without storage clears what it can', () => {
    vi.spyOn(Object, 'keys').mockImplementationOnce(() => {
      throw new Error('denied')
    })
    requestDraftInsert('1')
    clearChatDrafts()
    expect(takeDraftInsert('1')).toBeUndefined()
  })
})

describe('text for the draft', () => {
  it('waits for its pane, for the agent it was asked for only', () => {
    requestDraftInsert('1', { text: 'a' }, 'claude')
    expect(isTextInsert({ text: 'a' })).toBe(true)
    expect(isTextInsert(null)).toBe(false)
    expect(isTextInsert({ name: 'x', source: 'user' })).toBe(false)
    expect(takeDraftInsert('1', 'codex')).toBeUndefined()
    expect(takeDraftInsert('1', 'claude')).toBeUndefined()
    requestDraftInsert('1', { text: 'a' }, 'claude')
    expect(takeDraftInsert('1', 'claude')).toEqual({ text: 'a' })
    // Asked without an agent: any takes it
    requestDraftInsert('1', { text: 'b' })
    expect(takeDraftInsert('1', 'codex')).toEqual({ text: 'b' })
  })

  it('follows its pane when ids shift; one whose pane is gone is dropped', () => {
    requestDraftInsert('1', { text: 'a' })
    requestDraftInsert('3', { text: 'c' })
    remapChatDrafts({
      moved: new Map([['1', '2']]),
      stale: new Set(['1', '2', '3']),
    })
    expect(takeDraftInsert('1')).toBeUndefined()
    expect(takeDraftInsert('2')).toEqual({ text: 'a' })
    expect(takeDraftInsert('3')).toBeUndefined()
  })
})

describe('adoptChatDrafts', () => {
  it('moves a draft to its new key unless one is kept there', () => {
    saveDraft('0', 'tab draft')
    saveDraft('1', 'old')
    saveDraft('%5', 'pane draft')
    adoptChatDrafts(
      new Map([
        ['0', '%3'],
        ['1', '%5'],
        ['2', '%6'],
      ]),
    )
    expect(loadDraft('%3')).toBe('tab draft')
    expect(loadDraft('0')).toBe('')
    expect(loadDraft('%5')).toBe('pane draft')
    expect(loadDraft('1')).toBe('')
    expect(loadDraft('%6')).toBe('')
  })
})
