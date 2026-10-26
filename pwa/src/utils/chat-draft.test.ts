import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadDraft,
  onDraftInsert,
  remapChatDrafts,
  requestDraftInsert,
  saveDraft,
  takeDraftInsert,
} from './chat-draft'

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
