import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardContextMenu, keepsNativeMenu } from './context-menu-guard'

// Fires a contextmenu at the element and says whether the browser's menu was
// blocked
const blocked = (target: EventTarget) => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  target.dispatchEvent(e)
  return e.defaultPrevented
}

const mount = (html: string) => {
  document.body.innerHTML = html
  return document.body.firstElementChild as HTMLElement
}

describe('context menu guard', () => {
  let unguard: () => void

  beforeEach(() => {
    unguard = guardContextMenu()
  })

  afterEach(() => {
    unguard()
    document.getSelection()?.removeAllRanges()
    document.body.innerHTML = ''
  })

  it('blocks the menu over a button', () => {
    expect(blocked(mount('<button>Open</button>'))).toBe(true)
  })

  it.each([
    ['an input', '<input>'],
    ['a textarea', '<textarea></textarea>'],
    ['an editable element', '<div contenteditable="true">text</div>'],
    ['an editable element without a value', '<div contenteditable>text</div>'],
    ['a link', '<a href="https://example.com">link</a>'],
    ['an image', '<img alt="">'],
    ['a video', '<video></video>'],
    ['a marked region', '<div data-native-menu>text</div>'],
  ])('keeps the menu in %s', (_, html) => {
    expect(blocked(mount(html))).toBe(false)
  })

  it('keeps the menu inside a marked region', () => {
    const region = mount('<div data-native-menu><p><span>deep</span></p></div>')
    expect(blocked(region.querySelector('span')!)).toBe(false)
  })

  it('blocks the menu on an element marked not editable', () => {
    expect(blocked(mount('<div contenteditable="false">text</div>'))).toBe(true)
  })

  it('blocks the menu on a link without an address', () => {
    expect(blocked(mount('<a>anchor</a>'))).toBe(true)
  })

  it('decides from the parent of a text node', () => {
    const region = mount('<div data-native-menu>text</div>')
    expect(blocked(region.firstChild!)).toBe(false)
    const button = mount('<button>text</button>')
    expect(blocked(button.firstChild!)).toBe(true)
  })

  it('keeps the menu while text is selected', () => {
    const button = mount('<button>Open</button>')
    document.getSelection()!.selectAllChildren(button)
    expect(blocked(button)).toBe(false)
  })

  it('blocks the menu when the selection holds no text', () => {
    const button = mount('<button></button>')
    document.getSelection()!.selectAllChildren(button)
    expect(blocked(button)).toBe(true)
  })

  it('leaves an event a handler below already took', () => {
    const tabs = mount('<button>tab</button>')
    tabs.addEventListener('contextmenu', (e) => e.preventDefault())
    const selection = vi.spyOn(document, 'getSelection')
    expect(blocked(tabs)).toBe(true)
    expect(selection).not.toHaveBeenCalled()
    selection.mockRestore()
  })

  it('never sees an event a handler below stopped', () => {
    const terminal = mount('<div><button>cell</button></div>')
    terminal.addEventListener('contextmenu', (e) => e.stopPropagation())
    expect(blocked(terminal.querySelector('button')!)).toBe(false)
  })

  it('blocks the menu at the document itself', () => {
    expect(blocked(document)).toBe(true)
  })

  it('stops blocking once removed', () => {
    unguard()
    expect(blocked(mount('<button>Open</button>'))).toBe(false)
    unguard = guardContextMenu()
  })
})

describe('keepsNativeMenu', () => {
  it('blocks a target that is not a node', () => {
    expect(keepsNativeMenu(window, null)).toBe(false)
    expect(keepsNativeMenu(null, null)).toBe(false)
  })
})
