import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chatSelection,
  hasChatSelection,
  onChatSelection,
  resetChatSelections,
  setChatSelection,
  setChatSelectionServer,
} from './chat-selection'
import { resetFilesPersist, SIGNED_OUT_KEY, signedOut } from './files-persist'
import { remapPanes } from './pane-remap'

describe('chat selections', () => {
  beforeEach(() => resetChatSelections())
  afterEach(() => resetFilesPersist())

  it('keeps one per pane until forgotten', () => {
    expect(chatSelection('1')).toBe('')
    expect(hasChatSelection('1')).toBe(false)
    setChatSelection('1', 'a')
    setChatSelection('2', 'b')
    expect(chatSelection('1')).toBe('a')
    expect(hasChatSelection('2')).toBe(true)
    setChatSelection('1', null)
    expect(hasChatSelection('1')).toBe(false)
    setChatSelection('2', ' \n')
    expect(hasChatSelection('2')).toBe(false)
  })

  it('tells listeners only when a pane gains or loses one', () => {
    const fn = vi.fn()
    const off = onChatSelection(fn)
    setChatSelection('1', 'a')
    expect(fn).toHaveBeenCalledTimes(1)
    // A drag going on: the same pane, other text
    setChatSelection('1', 'ab')
    setChatSelection('1', 'abc')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(chatSelection('1')).toBe('abc')
    setChatSelection('2', null)
    expect(fn).toHaveBeenCalledTimes(1)
    setChatSelection('1', null)
    expect(fn).toHaveBeenCalledTimes(2)
    off()
    setChatSelection('1', 'a')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('another server drops them all', () => {
    const fn = vi.fn()
    onChatSelection(fn)
    setChatSelectionServer('i1')
    setChatSelection('1', 'a')
    setChatSelectionServer('i1')
    expect(chatSelection('1')).toBe('a')
    setChatSelectionServer('i2')
    expect(hasChatSelection('1')).toBe(false)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('follows its pane when ids shift', () => {
    setChatSelection('1', 'a')
    setChatSelection('3', 'c')
    remapPanes({
      moved: new Map([['1', '2']]),
      stale: new Set(['1', '2', '3']),
    })
    expect(hasChatSelection('1')).toBe(false)
    expect(chatSelection('2')).toBe('a')
    expect(hasChatSelection('3')).toBe(false)
  })

  it('is forgotten on sign-out, here or in another tab', () => {
    setChatSelection('1', 'a')
    signedOut()
    expect(hasChatSelection('1')).toBe(false)
    resetFilesPersist()
    resetChatSelections()
    setChatSelection('1', 'a')
    window.dispatchEvent(
      new StorageEvent('storage', { key: SIGNED_OUT_KEY, newValue: '1' }),
    )
    expect(hasChatSelection('1')).toBe(false)
  })
})
