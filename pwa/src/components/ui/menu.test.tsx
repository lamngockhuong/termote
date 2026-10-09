import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Menu, MenuGroup, MenuItem, MenuItemRadio, MenuSeparator } from './menu'
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

  it('aligns to the start when asked', () => {
    renderMenu({ align: 'start' })
    open()
    expect(screen.getByRole('menu')).toHaveClass('left-0')
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
