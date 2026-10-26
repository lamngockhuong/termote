import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetFilesPersist, SIGNED_OUT_KEY, signedOut } from './files-persist'
import { remapPanes } from './pane-remap'
import {
  paneSelection,
  recordSelection,
  resetPaneSelections,
  setSelectionServer,
} from './pane-selection'
import { MAX_TEMPLATE_TEXT, templateBytes } from './prompt-templates'

describe('pane selections', () => {
  beforeEach(() => resetPaneSelections())
  afterEach(() => resetFilesPersist())

  it('keeps the latest one that is not empty, per pane', () => {
    expect(paneSelection('1')).toBeNull()
    recordSelection('1', 'a', 'the terminal')
    recordSelection('1', '  \n', 'src/x.ts')
    recordSelection('2', 'b', 'src/x.ts')
    expect(paneSelection('1')).toEqual({ text: 'a', source: 'the terminal' })
    expect(paneSelection('2')).toEqual({ text: 'b', source: 'src/x.ts' })
  })

  it('cuts a long one to the template size, never inside a character', () => {
    recordSelection('1', 'é'.repeat(MAX_TEMPLATE_TEXT), 'the terminal')
    const kept = paneSelection('1')?.text as string
    expect(templateBytes(kept)).toBe(MAX_TEMPLATE_TEXT)
    recordSelection('1', `a${'é'.repeat(MAX_TEMPLATE_TEXT)}`, 'the terminal')
    const odd = paneSelection('1')?.text as string
    expect(templateBytes(odd)).toBe(MAX_TEMPLATE_TEXT - 1)
    expect(odd.endsWith('é')).toBe(true)
  })

  it('keeps a replacement character the text ends with', () => {
    recordSelection('1', 'a�', 'the terminal')
    expect(paneSelection('1')?.text).toBe('a�')
  })

  it('another server drops them all', () => {
    setSelectionServer('i1')
    recordSelection('1', 'a', 'the terminal')
    setSelectionServer('i1')
    expect(paneSelection('1')?.text).toBe('a')
    setSelectionServer('i2')
    expect(paneSelection('1')).toBeNull()
  })

  it('follows its pane when ids shift', () => {
    recordSelection('1', 'a', 'the terminal')
    recordSelection('3', 'c', 'the terminal')
    remapPanes({
      moved: new Map([['1', '2']]),
      stale: new Set(['1', '2', '3']),
    })
    expect(paneSelection('1')).toBeNull()
    expect(paneSelection('2')?.text).toBe('a')
    expect(paneSelection('3')).toBeNull()
  })

  it('is forgotten on sign-out, here or in another tab', () => {
    recordSelection('1', 'a', 'the terminal')
    signedOut()
    expect(paneSelection('1')).toBeNull()
    resetFilesPersist()
    resetPaneSelections()
    recordSelection('1', 'a', 'the terminal')
    window.dispatchEvent(
      new StorageEvent('storage', { key: SIGNED_OUT_KEY, newValue: '1' }),
    )
    expect(paneSelection('1')).toBeNull()
  })
})
