import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetAllShortcuts,
  SHORTCUTS_KEY,
  setShortcut,
} from '../hooks/use-shortcuts'
import type { AppCommand } from '../utils/app-commands'
import { ShortcutsSection } from './shortcuts-section'

const platform = vi.hoisted(() => ({ apple: false }))
vi.mock('../utils/platform', () => ({
  isApplePlatform: () => platform.apple,
}))
vi.mock('../hooks/use-media-query', () => ({
  useIsMobile: () => false,
}))

const COMMANDS: AppCommand[] = [
  {
    id: 'palette.quickOpen',
    title: 'tasks.command.quickOpen',
    category: 'tasks.category.palette',
    defaultKey: 'Mod+P',
    run: vi.fn(),
  },
  {
    id: 'palette.commands',
    title: 'tasks.command.commands',
    category: 'tasks.category.palette',
    defaultKey: 'Mod+Shift+P',
    inTerminal: true,
    run: vi.fn(),
  },
  {
    id: 'app.help',
    title: 'tasks.command.help',
    category: 'tasks.category.app',
    run: vi.fn(),
  },
  {
    id: 'app.about',
    title: 'tasks.command.about',
    category: 'tasks.category.app',
    run: vi.fn(),
  },
]

const row = (title: string) =>
  screen.getByText(title, { selector: 'span' }).closest('li') as HTMLElement
const change = (title: string) =>
  fireEvent.click(
    screen.getByRole('button', { name: `Change the key of ${title}` }),
  )
// A key pressed anywhere while a row records
function press(code: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', {
    code,
    key: code.replace(/^Key/, '').toLowerCase(),
    bubbles: true,
    cancelable: true,
    ...init,
  })
  act(() => {
    document.body.dispatchEvent(e)
  })
  return e
}

beforeEach(() => {
  platform.apple = false
  localStorage.clear()
  resetAllShortcuts()
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

describe('ShortcutsSection', () => {
  it('lists every command by category with its key', () => {
    render(<ShortcutsSection commands={COMMANDS} />)
    expect(screen.getByRole('region', { name: 'Palette' })).toBeVisible()
    expect(within(row('Go to file')).getByText('Ctrl+P')).toBeVisible()
    expect(within(row('Show help')).getByText('No key')).toBeVisible()
    expect(
      screen.getByRole('button', { name: 'Reset all shortcuts' }),
    ).toBeDisabled()
  })

  it('records a new key, which is saved and read back', () => {
    const view = render(<ShortcutsSection commands={COMMANDS} />)
    change('Go to file')
    expect(within(row('Go to file')).getByText('Press keys…')).toBeVisible()
    // A modifier alone waits for the key
    press('ControlLeft', { ctrlKey: true })
    const e = press('KeyO', { ctrlKey: true, altKey: true })
    expect(e.defaultPrevented).toBe(true)
    expect(within(row('Go to file')).getByText('Ctrl+Alt+O')).toBeVisible()
    expect(JSON.parse(localStorage.getItem(SHORTCUTS_KEY) ?? '')).toEqual({
      v: 1,
      keys: { 'palette.quickOpen': { key: 'Mod+Alt+O' } },
    })
    view.unmount()
    render(<ShortcutsSection commands={COMMANDS} />)
    expect(within(row('Go to file')).getByText('Ctrl+Alt+O')).toBeVisible()
  })

  it('refuses a key that would take a typed character, or one kept elsewhere', () => {
    render(<ShortcutsSection commands={COMMANDS} />)
    change('Show help')
    press('KeyK', { shiftKey: true })
    expect(within(row('Show help')).getByRole('alert')).toHaveTextContent(
      'Use Ctrl with a key',
    )
    press('KeyO', { altKey: true })
    press('KeyQ', { ctrlKey: true, altKey: true, modifierAltGraph: true })
    expect(localStorage.getItem(SHORTCUTS_KEY)).toBeNull()
    press('KeyW', { ctrlKey: true })
    expect(within(row('Show help')).getByRole('alert')).toHaveTextContent(
      'The browser keeps this key',
    )
    press('KeyS', { ctrlKey: true })
    expect(within(row('Show help')).getByRole('alert')).toHaveTextContent(
      'Used by the editor',
    )
    press('KeyC', { ctrlKey: true, shiftKey: true })
    expect(within(row('Show help')).getByRole('alert')).toHaveTextContent(
      'Used by the terminal',
    )
    press('Numpad5')
    expect(within(row('Show help')).getByRole('alert')).toHaveTextContent(
      'This key cannot be used',
    )
    expect(localStorage.getItem(SHORTCUTS_KEY)).toBeNull()
    // Escape gives up
    press('Escape', { key: 'Escape' })
    expect(within(row('Show help')).getByText('Change')).toBeVisible()
    expect(within(row('Show help')).queryByRole('alert')).toBeNull()
  })

  it('names ⌘ on Apple', () => {
    platform.apple = true
    render(<ShortcutsSection commands={COMMANDS} />)
    change('Show help')
    press('KeyK')
    expect(within(row('Show help')).getByRole('alert')).toHaveTextContent(
      'Use ⌘ with a key',
    )
  })

  it('stops recording when Change is pressed again', () => {
    render(<ShortcutsSection commands={COMMANDS} />)
    change('Show help')
    change('Show help')
    expect(within(row('Show help')).getByText('Change')).toBeVisible()
    press('KeyK', { ctrlKey: true })
    expect(within(row('Show help')).getByText('No key')).toBeVisible()
  })

  it('removes and resets one key, and all of them after asking', () => {
    render(<ShortcutsSection commands={COMMANDS} />)
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove the key of Go to file' }),
    )
    expect(within(row('Go to file')).getByText('No key')).toBeVisible()
    fireEvent.click(
      screen.getByRole('button', { name: 'Reset the key of Go to file' }),
    )
    expect(within(row('Go to file')).getByText('Ctrl+P')).toBeVisible()
    act(() => setShortcut('app.help', { key: 'F2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset all shortcuts' }))
    const dialog = screen.getByRole('dialog', { name: 'Reset all shortcuts?' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(within(row('Show help')).getByText('F2')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Reset all shortcuts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }))
    expect(within(row('Show help')).getByText('No key')).toBeVisible()
  })

  it('runs a key in the terminal only where the terminal does not use it', () => {
    render(<ShortcutsSection commands={COMMANDS} />)
    const palette = screen.getByRole('switch', {
      name: 'Show all commands: also in the terminal',
    })
    expect(palette).toBeChecked()
    fireEvent.click(palette)
    expect(palette).not.toBeChecked()
    const quick = screen.getByRole('switch', {
      name: 'Go to file: also in the terminal',
    })
    expect(quick).toBeDisabled()
    expect(row('Go to file')).toHaveTextContent('The terminal uses this key')
    expect(
      screen.getByRole('switch', { name: 'Show help: also in the terminal' }),
    ).toBeDisabled()
  })

  it('marks a key two commands share, and a default another one took', () => {
    act(() => {
      setShortcut('app.help', { key: 'Mod+K' })
      setShortcut('app.about', { key: 'Mod+K' })
      setShortcut('app.help', { key: 'Mod+K' })
    })
    render(<ShortcutsSection commands={COMMANDS} />)
    expect(row('Show help')).toHaveTextContent('Also used by About Termote')
    expect(row('About Termote')).toHaveTextContent('Also used by Show help')
    act(() => setShortcut('app.about', { key: 'Mod+P' }))
    expect(row('Go to file')).toHaveTextContent(
      'Replaced by your shortcut for About Termote',
    )
  })

  it('filters by name or key', () => {
    render(<ShortcutsSection commands={COMMANDS} />)
    const filter = screen.getByRole('searchbox', { name: 'Filter shortcuts' })
    fireEvent.change(filter, { target: { value: 'ctrl+shift' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.change(filter, { target: { value: 'help' } })
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    fireEvent.change(filter, { target: { value: 'zzz' } })
    expect(screen.getByText('No shortcut matches')).toBeVisible()
  })
})
