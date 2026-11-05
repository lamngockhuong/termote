import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionPane } from '../types/session'
import { SessionTabs } from './session-tabs'

const THREE: Session[] = [
  { id: 'a', name: 'Alpha', icon: '💻', description: '' },
  { id: 'b', name: 'Beta', icon: '🤖', description: '' },
  { id: 'c', name: 'Gamma', icon: '📁', description: '' },
]

const pane = (over: Partial<SessionPane>): SessionPane => ({
  id: 'p',
  label: '',
  hasAgent: false,
  ...over,
})
const tabOf = (name: string) =>
  screen.getByRole('tab', { name: new RegExp(name) })
const menu = () => screen.queryByRole('menu')
const item = (name: string | RegExp) =>
  within(screen.getByRole('menu')).getByRole('menuitem', { name })
const keyOn = (el: HTMLElement, key: string, opts = {}) => {
  el.focus()
  fireEvent.keyDown(el, { key, ...opts })
}

describe('SessionTabs: a tab’s menu', () => {
  const props = () => ({
    sessions: THREE,
    activeId: 'a',
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onRemove: vi.fn(),
    onMove: vi.fn(),
    onUpdate: vi.fn(),
  })

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.removeAttribute('open')
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('a right click opens it, its keys shown on the right', () => {
    render(<SessionTabs {...props()} />)
    const event = fireEvent.contextMenu(tabOf('Beta'))
    // The browser's own menu does not show
    expect(event).toBe(false)
    expect(screen.getByRole('menu', { name: 'Actions for Beta' })).toBeVisible()
    expect(item(/Rename/)).toHaveAttribute('aria-keyshortcuts', 'F2')
    expect(item(/Rename/)).toHaveTextContent('F2')
    expect(item(/Move left/)).toHaveTextContent('Alt+←')
    expect(item(/Move right/)).toHaveTextContent('Alt+→')
    expect(item(/Close/)).toHaveAttribute('aria-keyshortcuts', 'Delete')
    expect(item('Edit icon')).toBeEnabled()
    expect(item('New session…')).toBeEnabled()
    // Opened by the pointer, the box has the focus, not an item
    expect(document.activeElement).toBe(menu())
    // The browser's menu stays shut over it (the menu key's keyup)
    expect(fireEvent.contextMenu(item(/Rename/))).toBe(false)
    // Escape closes it, focus back on the tab
    fireEvent.keyDown(menu()!, { key: 'Escape' })
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(tabOf('Beta'))
  })

  it('Shift+F10 or the menu key opens it on the focused tab, first item focused', () => {
    render(<SessionTabs {...props()} />)
    keyOn(tabOf('Alpha'), 'F10', { shiftKey: true })
    expect(
      screen.getByRole('menu', { name: 'Actions for Alpha' }),
    ).toBeVisible()
    expect(document.activeElement).toBe(item(/Rename/))
    fireEvent.keyDown(menu()!, { key: 'Escape' })
    keyOn(tabOf('Gamma'), 'ContextMenu')
    expect(
      screen.getByRole('menu', { name: 'Actions for Gamma' }),
    ).toBeVisible()
    // F10 alone is not it
    fireEvent.keyDown(menu()!, { key: 'Escape' })
    keyOn(tabOf('Alpha'), 'F10')
    expect(menu()).toBeNull()
  })

  it('names the keys a tab answers to', () => {
    render(<SessionTabs {...props()} />)
    expect(tabOf('Alpha')).toHaveAttribute(
      'aria-keyshortcuts',
      'Shift+F10 F2 Alt+ArrowLeft Alt+ArrowRight Delete',
    )
  })

  it('view-only: no menu, no keys, and the browser’s menu shows', () => {
    render(
      <SessionTabs
        sessions={THREE}
        activeId="a"
        onSelect={vi.fn()}
        onRemove={vi.fn()}
        canRemove={false}
      />,
    )
    expect(fireEvent.contextMenu(tabOf('Beta'))).toBe(true)
    keyOn(tabOf('Alpha'), 'F10', { shiftKey: true })
    keyOn(tabOf('Alpha'), 'F2')
    keyOn(tabOf('Alpha'), 'ArrowRight', { altKey: true })
    expect(menu()).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(tabOf('Alpha')).not.toHaveAttribute('aria-keyshortcuts')
    expect(screen.queryByRole('button', { name: 'Add session' })).toBeNull()
  })

  it('offers only what is there: no move without onMove, no close for the last tab', () => {
    const p = props()
    render(
      <SessionTabs
        {...p}
        onMove={undefined}
        onAdd={undefined}
        canRemove={false}
      />,
    )
    fireEvent.contextMenu(tabOf('Alpha'))
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'RenameF2',
      'Edit icon',
    ])
  })

  describe('rename', () => {
    it('F2 edits the name in place: Enter saves it, focus back on the tab', () => {
      const p = props()
      render(<SessionTabs {...p} />)
      keyOn(tabOf('Alpha'), 'F2')
      const field = screen.getByRole('textbox', { name: 'New name for Alpha' })
      expect(field).toHaveFocus()
      expect(field).toHaveValue('Alpha')
      // Its keys stay its own: no tab key acts on them
      fireEvent.keyDown(field, { key: 'Delete' })
      expect(p.onRemove).not.toHaveBeenCalled()
      fireEvent.change(field, { target: { value: '  Api  ' } })
      fireEvent.keyDown(field, { key: 'Enter' })
      expect(p.onUpdate).toHaveBeenCalledWith('a', { name: 'Api' })
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(tabOf('Alpha')).toHaveFocus()
    })

    it('Escape, an empty name or the same name changes nothing', () => {
      const p = props()
      render(<SessionTabs {...p} />)
      for (const [value, key] of [
        ['Other', 'Escape'],
        ['   ', 'Enter'],
        ['Alpha', 'Enter'],
      ]) {
        keyOn(tabOf('Alpha'), 'F2')
        const field = screen.getByRole('textbox')
        fireEvent.change(field, { target: { value } })
        // Other keys type
        fireEvent.keyDown(field, { key: 'a' })
        fireEvent.keyDown(field, { key })
        expect(screen.queryByRole('textbox')).toBeNull()
      }
      expect(p.onUpdate).not.toHaveBeenCalled()
    })

    it('Enter or Escape ending an IME composition is the IME’s', () => {
      const p = props()
      render(<SessionTabs {...p} />)
      keyOn(tabOf('Alpha'), 'F2')
      const field = screen.getByRole('textbox')
      fireEvent.change(field, { target: { value: 'Ápi' } })
      fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
      fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
      expect(field).toBeInTheDocument()
      expect(p.onUpdate).not.toHaveBeenCalled()
    })

    it('leaving the field cancels it', () => {
      const p = props()
      render(<SessionTabs {...p} />)
      keyOn(tabOf('Beta'), 'F2')
      const field = screen.getByRole('textbox')
      fireEvent.change(field, { target: { value: 'Other' } })
      fireEvent.blur(field)
      expect(screen.queryByRole('textbox')).toBeNull()
      expect(p.onUpdate).not.toHaveBeenCalled()
    })

    it('from the menu as well; a tab being renamed has no menu and does not drag', () => {
      const p = props()
      render(<SessionTabs {...p} />)
      fireEvent.contextMenu(tabOf('Gamma'))
      fireEvent.click(item(/Rename/))
      const field = screen.getByRole('textbox', { name: 'New name for Gamma' })
      expect(field).toHaveFocus()
      const wrapper = field.closest('.group') as HTMLElement
      expect(wrapper).not.toHaveAttribute('draggable')
      expect(fireEvent.contextMenu(wrapper)).toBe(true)
      expect(menu()).toBeNull()
    })

    it('a backend that keeps its tab names: Rename says why it is off, F2 does nothing', () => {
      render(<SessionTabs {...props()} renameTab={false} />)
      keyOn(tabOf('Alpha'), 'F2')
      expect(screen.queryByRole('textbox')).toBeNull()
      fireEvent.contextMenu(tabOf('Alpha'))
      expect(item(/Rename/)).toBeDisabled()
      expect(item(/Rename/).title).toMatch(/herdr-app/)
      expect(item('Edit icon')).toBeEnabled()
    })
  })

  it('Edit icon opens the icons; one picked is saved, closing picks none', () => {
    const p = props()
    render(<SessionTabs {...p} />)
    fireEvent.contextMenu(tabOf('Beta'))
    fireEvent.click(item('Edit icon'))
    const sheet = screen.getByRole('dialog', { name: 'Choose Icon' })
    expect(within(sheet).getByRole('button', { name: '🤖' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    fireEvent.click(within(sheet).getByRole('button', { name: '🚀' }))
    expect(p.onUpdate).toHaveBeenCalledWith('b', { icon: '🚀' })
    expect(screen.queryByRole('dialog', { name: 'Choose Icon' })).toBeNull()
    fireEvent.contextMenu(tabOf('Beta'))
    fireEvent.click(item('Edit icon'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog', { name: 'Choose Icon' })).toBeNull()
    expect(p.onUpdate).toHaveBeenCalledTimes(1)
  })

  describe('move', () => {
    it('Alt+Left/Right moves the focused tab and keeps the focus on it', () => {
      const p = props()
      const { rerender } = render(<SessionTabs {...p} />)
      keyOn(tabOf('Alpha'), 'ArrowRight', { altKey: true })
      expect(p.onMove).toHaveBeenCalledWith('a', 1)
      // On its way: still in the old order, the focus waits
      rerender(<SessionTabs {...p} moving />)
      ;(document.activeElement as HTMLElement).blur()
      rerender(<SessionTabs {...p} moving />)
      expect(tabOf('Alpha')).not.toHaveFocus()
      // The server's new order comes back
      rerender(<SessionTabs {...p} sessions={[THREE[1], THREE[0], THREE[2]]} />)
      expect(tabOf('Alpha')).toHaveFocus()
      keyOn(tabOf('Gamma'), 'ArrowLeft', { altKey: true })
      expect(p.onMove).toHaveBeenLastCalledWith('c', 1)
      // Nothing past the ends
      p.onMove.mockClear()
      keyOn(tabOf('Gamma'), 'ArrowRight', { altKey: true })
      expect(p.onMove).not.toHaveBeenCalled()
      // Without onMove, Alt+arrow neither moves, walks the tabs nor goes
      // back a page
      rerender(<SessionTabs {...p} onMove={undefined} />)
      tabOf('Beta').focus()
      expect(
        fireEvent.keyDown(tabOf('Beta'), { key: 'ArrowLeft', altKey: true }),
      ).toBe(false)
      expect(tabOf('Beta')).toHaveFocus()
    })

    it('from the menu, the ends disabled', () => {
      const p = props()
      render(<SessionTabs {...p} />)
      fireEvent.contextMenu(tabOf('Alpha'))
      expect(item(/Move left/)).toBeDisabled()
      fireEvent.click(item(/Move right/))
      expect(p.onMove).toHaveBeenCalledWith('a', 1)
      fireEvent.contextMenu(tabOf('Gamma'))
      expect(item(/Move right/)).toBeDisabled()
      fireEvent.click(item(/Move left/))
      expect(p.onMove).toHaveBeenLastCalledWith('c', 1)
    })

    it('follows a tab renumbered by the move (tmux: the id is the window number)', () => {
      const p = props()
      const win = (id: string, key: string, name: string): Session => ({
        id,
        key,
        name,
        icon: '💻',
        description: '',
      })
      const before = [win('$1:0', '@5', 'one'), win('$1:1', '@6', 'two')]
      const { rerender } = render(<SessionTabs {...p} sessions={before} />)
      keyOn(tabOf('two'), 'ArrowLeft', { altKey: true })
      expect(p.onMove).toHaveBeenCalledWith('$1:1', 0)
      // "two" is window 0 now, and "one" holds its old id
      rerender(
        <SessionTabs
          {...p}
          sessions={[win('$1:0', '@6', 'two'), win('$1:1', '@5', 'one')]}
        />,
      )
      expect(tabOf('two')).toHaveFocus()
      // The menu hangs from the tab it was asked on
      fireEvent.contextMenu(tabOf('one'))
      expect(
        screen.getByRole('menu', { name: 'Actions for one' }),
      ).toBeVisible()
    })

    it('a moved tab gone before it is drawn again takes no focus', () => {
      const p = props()
      const { rerender } = render(<SessionTabs {...p} />)
      keyOn(tabOf('Alpha'), 'ArrowRight', { altKey: true })
      rerender(<SessionTabs {...p} sessions={[THREE[1], THREE[2]]} />)
      expect(document.activeElement).not.toBe(screen.queryByText('Alpha'))
    })
  })

  it('Close asks to close the tab, as its X does', () => {
    const p = props()
    render(<SessionTabs {...p} />)
    fireEvent.contextMenu(tabOf('Beta'))
    fireEvent.click(item(/Close/))
    expect(p.onRemove).toHaveBeenCalledWith('b')
  })

  it('closes with its tab', () => {
    const p = props()
    const { rerender } = render(<SessionTabs {...p} />)
    fireEvent.contextMenu(tabOf('Beta'))
    rerender(<SessionTabs {...p} sessions={[THREE[0], THREE[2]]} />)
    expect(menu()).toBeNull()
  })

  it('a tab fading out has no menu', () => {
    const real = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
      el.classList.contains('group')
        ? ({
            transitionDuration: '150ms',
            transitionDelay: '0s',
          } as CSSStyleDeclaration)
        : real(el),
    )
    const p = props()
    const { rerender } = render(<SessionTabs {...p} />)
    rerender(<SessionTabs {...p} sessions={[THREE[0], THREE[2]]} />)
    const leaving = screen.getByText('Beta').closest('.group') as HTMLElement
    expect(leaving).toHaveAttribute('data-leaving', 'true')
    expect(fireEvent.contextMenu(leaving)).toBe(true)
    expect(menu()).toBeNull()
  })

  describe('a new tab with a name', () => {
    it('New session… opens the form: a name and an icon, Enter adds', () => {
      const p = props()
      render(<SessionTabs {...p} />)
      fireEvent.contextMenu(tabOf('Alpha'))
      fireEvent.click(item('New session…'))
      const form = screen.getByRole('form', { name: 'New session' })
      const name = within(form).getByRole('textbox', { name: 'Session name' })
      expect(name).toHaveFocus()
      // No name, nothing added
      fireEvent.submit(form)
      expect(p.onAdd).not.toHaveBeenCalled()
      fireEvent.click(within(form).getByTitle('Change icon'))
      // Escape in the icons leaves the form open
      fireEvent.keyDown(screen.getByRole('button', { name: '🚀' }), {
        key: 'Escape',
      })
      expect(screen.getByRole('form')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '🚀' }))
      fireEvent.change(name, { target: { value: ' api ' } })
      fireEvent.click(within(form).getByRole('button', { name: 'Add' }))
      expect(p.onAdd).toHaveBeenCalledWith('api', '🚀')
      expect(screen.queryByRole('form')).toBeNull()
      // Back on the tab it was asked from
      expect(tabOf('Alpha')).toHaveFocus()
    })

    it('the Add button asks for it where askName is set, else adds at once', () => {
      const p = props()
      const { rerender } = render(<SessionTabs {...p} />)
      const add = screen.getByRole('button', { name: 'Add session' })
      expect(add).not.toHaveAttribute('aria-expanded')
      fireEvent.click(add)
      expect(p.onAdd).toHaveBeenCalledWith()
      expect(screen.queryByRole('form')).toBeNull()
      rerender(<SessionTabs {...p} askName />)
      fireEvent.click(add)
      expect(add).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByRole('form', { name: 'New session' })).toBeVisible()
      expect(p.onAdd).toHaveBeenCalledTimes(1)
    })

    it('Escape, Cancel or a press outside closes it; a press inside does not', () => {
      render(<SessionTabs {...props()} askName />)
      const add = screen.getByRole('button', { name: 'Add session' })
      const form = () => screen.queryByRole('form')
      fireEvent.click(add)
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' })
      fireEvent.keyDown(screen.getByRole('textbox'), {
        key: 'Escape',
        isComposing: true,
      })
      expect(form()).not.toBeNull()
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
      expect(form()).toBeNull()
      expect(add).toHaveFocus()
      // + closes it as well, a press on it not counted as outside
      fireEvent.click(add)
      fireEvent.pointerDown(add)
      fireEvent.click(add)
      expect(form()).toBeNull()
      fireEvent.click(add)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(form()).toBeNull()
      fireEvent.click(add)
      fireEvent.pointerDown(screen.getByRole('textbox'))
      expect(form()).not.toBeNull()
      act(() => {
        fireEvent.pointerDown(document.body)
      })
      expect(form()).toBeNull()
    })
  })

  describe('hover', () => {
    it('shows what runs in a tab and a one-pane tab’s pane and metadata', () => {
      render(
        <SessionTabs
          {...props()}
          sessions={[
            {
              ...THREE[0],
              description: 'API',
              commands: ['vim', 'node'],
              panes: [
                pane({ name: 'server', meta: [{ key: 'pr', value: '#12' }] }),
              ],
            },
            {
              ...THREE[1],
              panes: [pane({ meta: [{ key: 'k', value: 'v' }] })],
            },
            { ...THREE[2], panes: [pane({ name: 'x' }), pane({ id: 'q' })] },
            {
              id: 'd',
              name: 'Delta',
              icon: '🔧',
              description: '',
              panes: [pane({ name: 'db' })],
            },
          ]}
        />,
      )
      expect(tabOf('Alpha').title).toBe(
        'Alpha - API\nserver · pr: #12\nvim, node',
      )
      expect(tabOf('Beta').title).toBe('Beta\nk: v')
      // Two panes: the pane strip names them
      expect(tabOf('Gamma').title).toBe('Gamma')
      expect(tabOf('Delta').title).toBe('Delta\ndb')
    })
  })
})
