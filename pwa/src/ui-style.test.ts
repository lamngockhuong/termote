import { afterEach, describe, expect, it } from 'vitest'
import {
  accentColor,
  applyUiAccent,
  applyUiStyle,
  DEFAULT_UI_ACCENT,
  DEFAULT_UI_STYLE,
  readToken,
  resolveUiAccent,
  resolveUiStyle,
  syncThemeColor,
  UI_ACCENTS,
  UI_STYLES,
  type UiAccent,
  type UiStyle,
} from './ui-style'

const root = document.documentElement

function addThemeColorMeta(content: string) {
  const meta = document.createElement('meta')
  meta.name = 'theme-color'
  meta.content = content
  document.head.append(meta)
  return meta
}

describe('ui-style', () => {
  afterEach(() => {
    delete root.dataset.uiStyle
    delete root.dataset.accent
    root.style.removeProperty('--tm-bg')
    for (const m of document.querySelectorAll('meta[name="theme-color"]'))
      m.remove()
  })

  it('lists the three styles with neutral as the default', () => {
    expect(UI_STYLES.map((s) => s.id)).toEqual([
      'neutral',
      'terminal',
      'native',
    ])
    expect(DEFAULT_UI_STYLE).toBe('neutral')
  })

  it('keeps a known style and falls back to neutral for anything else', () => {
    expect(resolveUiStyle('terminal')).toBe('terminal')
    expect(resolveUiStyle('native')).toBe('native')
    expect(resolveUiStyle('fancy')).toBe('neutral')
    expect(resolveUiStyle(undefined)).toBe('neutral')
    expect(resolveUiStyle(3)).toBe('neutral')
  })

  it('sets data-ui-style on <html>, replacing an unknown value with neutral', () => {
    applyUiStyle('native')
    expect(root.getAttribute('data-ui-style')).toBe('native')
    applyUiStyle('bogus' as UiStyle)
    expect(root.getAttribute('data-ui-style')).toBe('neutral')
  })

  it('lists follow-style first, then the seven accent colors', () => {
    expect(UI_ACCENTS.map((a) => a.id)).toEqual([
      'auto',
      'indigo',
      'blue',
      'teal',
      'green',
      'orange',
      'pink',
      'violet',
    ])
    expect(DEFAULT_UI_ACCENT).toBe('auto')
  })

  it('keeps a known accent and falls back to auto for anything else', () => {
    expect(resolveUiAccent('teal')).toBe('teal')
    expect(resolveUiAccent('auto')).toBe('auto')
    expect(resolveUiAccent('gold')).toBe('auto')
    expect(resolveUiAccent(null)).toBe('auto')
    expect(resolveUiAccent(undefined)).toBe('auto')
    expect(resolveUiAccent(3)).toBe('auto')
  })

  it('gives the colors of an accent, none for auto', () => {
    expect(accentColor('teal')?.dark[0]).toBe('#2dd4bf')
    expect(accentColor('auto')).toBeUndefined()
  })

  it('sets data-accent on <html> for a color and removes it for auto', () => {
    applyUiAccent('pink')
    expect(root.getAttribute('data-accent')).toBe('pink')
    applyUiAccent('bogus' as UiAccent)
    expect(root.hasAttribute('data-accent')).toBe(false)
    applyUiAccent('violet')
    applyUiAccent('auto')
    expect(root.hasAttribute('data-accent')).toBe(false)
  })

  it('reads a token from <html>, empty when it is not defined', () => {
    expect(readToken('--tm-bg')).toBe('')
    root.style.setProperty('--tm-bg', ' #123456 ')
    expect(readToken('--tm-bg')).toBe('#123456')
  })

  it('points every theme-color meta at the current background', () => {
    const dark = addThemeColorMeta('#000000')
    const light = addThemeColorMeta('#ffffff')
    root.style.setProperty('--tm-bg', '#f2f2f7')
    syncThemeColor()
    expect(dark.content).toBe('#f2f2f7')
    expect(light.content).toBe('#f2f2f7')
  })

  it('leaves theme-color alone when the token is not readable', () => {
    const meta = addThemeColorMeta('#09090b')
    syncThemeColor()
    expect(meta.content).toBe('#09090b')
  })
})
