import { afterEach, describe, expect, it } from 'vitest'
import {
  applyUiStyle,
  DEFAULT_UI_STYLE,
  readToken,
  resolveUiStyle,
  syncThemeColor,
  UI_STYLES,
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
