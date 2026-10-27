import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuItemRadio,
  MenuSeparator,
  placeMenu,
} from './menu'
import { SegmentedControl } from './segmented-control'

function renderMenu(props: Partial<Parameters<typeof Menu>[0]> = {}) {
  const onSettings = vi.fn()
  const onAbout = vi.fn()
  const onClear = vi.fn()
  render(
    <div>
      <button type="button">Outside</button>
      <Menu label="More" trigger="⋯" {...props}>
        <MenuItem onSelect={onSettings} icon={<svg />}>
          Settings
        </MenuItem>
        <MenuItem onSelect={vi.fn()} disabled>
          Disabled
        </MenuItem>
        <MenuItem onSelect={onAbout}>About</MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={onClear} danger keepOpen icon={<svg />}>
          Clear cache
        </MenuItem>
      </Menu>
    </div>,
  )
  return { onSettings, onAbout, onClear }
}

const trigger = () => screen.getByRole('button', { name: 'More' })
// detail 0: a click from Enter/Space, as the keyboard sends it
const open = () => fireEvent.click(trigger(), { detail: 0 })
const tapOpen = () => fireEvent.click(trigger(), { detail: 1 })
const item = (name: string) => screen.getByRole('menuitem', { name })

describe('Menu', () => {
  it('is closed at first and opens from its trigger', () => {
    renderMenu()
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    open()
    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    const menu = screen.getByRole('menu', { name: 'More' })
    expect(trigger()).toHaveAttribute('aria-controls', menu.id)
    expect(menu).toHaveClass('right-0')
  })

  it('can have a trigger of text, opened from the keyboard too', () => {
    renderMenu({ trigger: 'Shift-JIS', textTrigger: 'text-[11px]' })
    expect(trigger()).toHaveTextContent('Shift-JIS')
    expect(trigger()).toHaveClass('text-[11px]')
    expect(trigger()).not.toHaveClass('size-10')
    open()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(item('Settings')).toHaveFocus()
  })

  it('aligns to the start when asked', () => {
    renderMenu({ align: 'start' })
    open()
    expect(screen.getByRole('menu')).toHaveClass('left-0')
  })

  it.each([
    ['left', { left: -28, right: 228 }, 'translateX(36px)'],
    ['right', { left: 300, right: 556 }, 'translateX(-174px)'],
    ['neither', { left: 100, right: 356 }, ''],
  ])('keeps itself on the screen past the %s edge', (_, box, transform) => {
    const width = vi
      .spyOn(document.documentElement, 'clientWidth', 'get')
      .mockReturnValue(390)
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ ...box, width: 256 } as DOMRect)
    renderMenu()
    tapOpen()
    expect(screen.getByRole('menu').style.transform).toBe(transform)
    // Closed and opened again, it is measured again
    rect.mockReturnValue({ left: 100, right: 356, width: 256 } as DOMRect)
    tapOpen()
    tapOpen()
    expect(screen.getByRole('menu').style.transform).toBe('')
    width.mockRestore()
    rect.mockRestore()
  })

  it('toggles closed from the trigger', () => {
    renderMenu()
    open()
    open()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on a second tap that blurs the menu before its click', () => {
    renderMenu()
    fireEvent.pointerDown(trigger())
    tapOpen()
    expect(screen.getByRole('menu')).toBeInTheDocument()
    // Safari/iOS: the tap does not focus the trigger, so the menu box loses
    // focus to nothing and the blur closes the menu before the click lands.
    fireEvent.pointerDown(trigger())
    fireEvent.blur(screen.getByRole('menu'), { relatedTarget: null })
    tapOpen()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes on a second click where the click focuses the trigger', () => {
    renderMenu()
    fireEvent.pointerDown(trigger())
    tapOpen()
    fireEvent.pointerDown(trigger())
    fireEvent.blur(screen.getByRole('menu'), { relatedTarget: trigger() })
    tapOpen()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('lets Enter decide by the open state, not an earlier press', () => {
    renderMenu()
    open()
    // A press on the open menu's trigger that never became a click, then a
    // press outside closing it: the first press's state is left behind.
    fireEvent.pointerDown(trigger())
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    open()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('focuses the first enabled item on open', () => {
    renderMenu()
    open()
    expect(document.activeElement).toBe(item('Settings'))
  })

  it('moves with the arrow keys, Home and End, skipping disabled items', () => {
    renderMenu()
    open()
    const key = (k: string) =>
      fireEvent.keyDown(document.activeElement!, { key: k })
    key('ArrowDown')
    expect(document.activeElement).toBe(item('About'))
    key('ArrowDown')
    expect(document.activeElement).toBe(item('Clear cache'))
    key('ArrowDown')
    expect(document.activeElement).toBe(item('Settings'))
    key('ArrowUp')
    expect(document.activeElement).toBe(item('Clear cache'))
    key('Home')
    expect(document.activeElement).toBe(item('Settings'))
    key('End')
    expect(document.activeElement).toBe(item('Clear cache'))
    key('a')
    expect(document.activeElement).toBe(item('Clear cache'))
  })

  it('focuses the menu box, not an item, when opened by a tap', () => {
    renderMenu()
    tapOpen()
    const menu = screen.getByRole('menu')
    expect(menu).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(item('Settings')).toHaveFocus()
    menu.focus()
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(item('Clear cache')).toHaveFocus()
    menu.focus()
    fireEvent.keyDown(menu, { key: 'a' })
    expect(menu).toHaveFocus()
  })

  it('closes on Escape and gives focus back to the trigger', () => {
    renderMenu()
    open()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger())
  })

  it('closes when focus moves out (Tab) without taking focus back', () => {
    renderMenu()
    open()
    const outside = screen.getByRole('button', { name: 'Outside' })
    fireEvent.blur(item('Settings'), { relatedTarget: outside })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).not.toBe(trigger())
  })

  it('stays open while focus moves between the trigger and its items', () => {
    renderMenu()
    open()
    fireEvent.blur(item('Settings'), { relatedTarget: item('About') })
    fireEvent.blur(item('About'), { relatedTarget: trigger() })
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('closes on a press outside but not on a press inside', () => {
    renderMenu()
    open()
    fireEvent.pointerDown(screen.getByRole('menu'))
    expect(screen.getByRole('menu')).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('leaves arrow keys to a control inside the menu', () => {
    const onChange = vi.fn()
    render(
      <Menu label="More" trigger="⋯">
        <MenuItem onSelect={vi.fn()}>Settings</MenuItem>
        <SegmentedControl
          label="Theme"
          value="dark"
          onChange={onChange}
          options={[
            { value: 'light', content: 'Light' },
            { value: 'dark', content: 'Dark' },
          ]}
        />
      </Menu>,
    )
    open()
    const dark = screen.getByRole('radio', { name: 'Dark' })
    dark.focus()
    fireEvent.keyDown(dark, { key: 'ArrowDown' })
    expect(onChange).toHaveBeenCalledWith('light')
    // Focus stays in the radio group instead of jumping to the first item
    expect(document.activeElement).toBe(
      screen.getByRole('radio', { name: 'Light' }),
    )
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('runs an item and closes, back on the trigger', () => {
    const { onSettings } = renderMenu()
    open()
    fireEvent.click(item('Settings'))
    expect(onSettings).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger())
  })

  it('closes on an item without an action', () => {
    render(
      <Menu label="More" trigger="⋯">
        <MenuItem>Note</MenuItem>
      </Menu>,
    )
    open()
    fireEvent.click(item('Note'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('keeps the menu open for a keepOpen item and marks danger items', () => {
    const { onClear } = renderMenu()
    open()
    expect(item('Clear cache')).toHaveClass('text-danger')
    expect(item('About')).toHaveClass('text-fg')
    fireEvent.click(item('Clear cache'))
    expect(onClear).toHaveBeenCalledOnce()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('leaves focus alone when no item is enabled', () => {
    render(
      <Menu label="Empty" trigger="⋯">
        <MenuItem onSelect={vi.fn()} disabled>
          Nothing
        </MenuItem>
      </Menu>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Empty' }))
    const before = document.activeElement
    const nothing = screen.getByRole('menuitem', { name: 'Nothing' })
    fireEvent.keyDown(nothing, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(before)
  })

  it('lets an item run outside a menu', () => {
    const onSelect = vi.fn()
    render(<MenuItem onSelect={onSelect}>Alone</MenuItem>)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alone' }))
    expect(onSelect).toHaveBeenCalledOnce()
  })

  it('offers a labelled group of radio items that arrows reach', () => {
    const onDark = vi.fn()
    render(
      <Menu label="More" trigger="⋯">
        <MenuItem onSelect={vi.fn()}>Settings</MenuItem>
        <MenuGroup label="Theme">
          <MenuItemRadio checked={false} onSelect={vi.fn()} keepOpen>
            Light
          </MenuItemRadio>
          <MenuItemRadio checked onSelect={onDark} keepOpen>
            Dark
          </MenuItemRadio>
        </MenuGroup>
      </Menu>,
    )
    open()
    expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument()
    const light = screen.getByRole('menuitemradio', { name: 'Light' })
    const dark = screen.getByRole('menuitemradio', { name: 'Dark' })
    expect(light).toHaveAttribute('aria-checked', 'false')
    expect(dark).toHaveAttribute('aria-checked', 'true')
    expect(dark.querySelector('svg')).toBeInTheDocument()
    expect(light.querySelector('svg')).not.toBeInTheDocument()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(light)
    fireEvent.keyDown(light, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(dark)
    fireEvent.click(dark)
    expect(onDark).toHaveBeenCalledOnce()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('plain items are menuitem without aria-checked', () => {
    renderMenu()
    open()
    expect(item('About')).not.toHaveAttribute('aria-checked')
  })
})

describe('placeMenu', () => {
  const view = { width: 1000, top: 0, height: 800 }
  const menu = { width: 256, height: 200 }
  const at = (left: number, top: number, w = 32, h = 32) =>
    ({ left, top, right: left + w, bottom: top + h }) as DOMRect

  it('opens under the trigger, aligned to its end or its start', () => {
    expect(placeMenu(at(500, 100), menu, 'end', view)).toEqual({
      left: 276,
      top: 140,
      maxHeight: undefined,
    })
    expect(placeMenu(at(500, 100), menu, 'start', view).left).toBe(500)
  })

  it('stays inside the screen sideways', () => {
    expect(placeMenu(at(10, 100), menu, 'end', view).left).toBe(8)
    expect(placeMenu(at(900, 100), menu, 'start', view).left).toBe(736)
  })

  it('opens above when there is no room below and more above', () => {
    expect(placeMenu(at(500, 700), menu, 'end', view)).toEqual({
      left: 276,
      top: 492,
      maxHeight: undefined,
    })
  })

  it('caps its height on the roomier side when neither holds it', () => {
    const tall = { width: 256, height: 900 }
    expect(placeMenu(at(500, 600), tall, 'end', view)).toEqual({
      left: 276,
      top: 8,
      maxHeight: 584,
    })
    expect(placeMenu(at(500, 100), tall, 'end', view)).toEqual({
      left: 276,
      top: 140,
      maxHeight: 652,
    })
  })

  it('counts only the visible part of the viewport (an open keyboard)', () => {
    // 400px visible from 100px down: 260px left under a trigger at 200
    const kb = { width: 1000, top: 100, height: 400 }
    expect(placeMenu(at(500, 200), menu, 'end', kb).top).toBe(240)
    expect(placeMenu(at(500, 300), menu, 'end', kb)).toEqual({
      left: 276,
      top: 108,
      maxHeight: 184,
    })
  })
})

describe('Menu in the top layer', () => {
  const show = vi.fn()
  beforeEach(() => {
    show.mockClear()
    Object.defineProperty(HTMLElement.prototype, 'showPopover', {
      configurable: true,
      value: show,
    })
  })
  // jsdom hides every [popover]: it has no :popover-open
  const menu = () => screen.queryByRole('menu', { hidden: true })
  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover
    vi.restoreAllMocks()
  })

  it('shows as a manual popover, placed in the viewport', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 500,
      top: 100,
      right: 532,
      bottom: 132,
    } as DOMRect)
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(
      1000,
    )
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(256)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    renderMenu()
    tapOpen()
    const list = menu()!
    expect(list).toHaveAttribute('popover', 'manual')
    expect(show.mock.contexts[0]).toBe(list)
    expect(list).toHaveClass('fixed', 'inset-auto', 'm-0')
    expect(list).not.toHaveClass('absolute')
    expect(list.style.left).toBe('276px')
    expect(list.style.top).toBe('140px')
    expect(list.style.maxHeight).toBe('')
  })

  it('closes when a list holding its trigger scrolls, not another', () => {
    render(
      <div>
        <div data-testid="other" />
        <div data-testid="list">
          <Menu label="More" trigger="⋯">
            <MenuItem>Settings</MenuItem>
          </Menu>
        </div>
      </div>,
    )
    tapOpen()
    fireEvent.scroll(menu()!)
    fireEvent.scroll(screen.getByTestId('other'))
    expect(menu()).toBeInTheDocument()
    fireEvent.scroll(screen.getByTestId('list'))
    expect(menu()).toBeNull()
    tapOpen()
    fireEvent.scroll(document)
    expect(menu()).toBeNull()
  })

  it('caps its height when neither side holds it, and scrolls inside', () => {
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(
      1000,
    )
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 500,
      top: 100,
      right: 532,
      bottom: 132,
    } as DOMRect)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(2000)
    renderMenu()
    tapOpen()
    expect(menu()!.style.top).toBe('140px')
    expect(menu()!.style.maxHeight).toBe('652px')
    expect(menu()).toHaveClass('overflow-y-auto')
  })

  it('places itself again when the window resizes', () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        left: 500,
        top: 100,
        right: 532,
        bottom: 132,
      } as DOMRect)
    renderMenu()
    tapOpen()
    expect(menu()!.style.top).toBe('140px')
    rect.mockReturnValue({
      left: 500,
      top: 200,
      right: 532,
      bottom: 232,
    } as DOMRect)
    fireEvent(window, new Event('resize'))
    expect(menu()).toBeInTheDocument()
    expect(menu()!.style.top).toBe('240px')
  })
})

describe('Menu without the top layer', () => {
  it('stays absolute under its trigger, with no popover', () => {
    renderMenu()
    tapOpen()
    const menu = screen.getByRole('menu')
    expect(menu).not.toHaveAttribute('popover')
    expect(menu).toHaveClass('absolute', 'top-full', 'right-0')
    fireEvent.scroll(document.body)
    expect(menu).toBeInTheDocument()
  })
})
