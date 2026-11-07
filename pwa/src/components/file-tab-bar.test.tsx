import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LONG_PRESS_MS } from '../hooks/use-long-press'
import { FileTabBar, type TabEntry, type TabListProps } from './file-tab-bar'
import { MenuItem } from './ui/menu'

const entry = (id: string, over: Partial<TabEntry> = {}): TabEntry => ({
  id,
  name: `${id}.md`,
  title: `docs/${id}.md`,
  pinned: true,
  dirty: false,
  ...over,
})

function show(over: Partial<TabListProps> = {}) {
  const props: TabListProps = {
    tabs: [
      entry('a'),
      entry('b', { pinned: false }),
      entry('c', { dirty: true }),
    ],
    activeId: 'a',
    homeLabel: 'Files',
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onPin: vi.fn(),
    ...over,
  }
  const view = render(<FileTabBar {...props} />)
  return { ...props, ...view }
}

const tab = (name: RegExp | string) => screen.getByRole('tab', { name })

describe('FileTabBar', () => {
  it('lists the list entry, then each file with its state', () => {
    show()
    expect(screen.getByRole('tablist', { name: 'Open files' })).toBeVisible()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Files',
      'a.md',
      'b.md (preview)',
      'c.md (unsaved changes)',
    ])
    expect(tab('a.md')).toHaveAttribute('aria-selected', 'true')
    expect(tab('a.md')).toHaveAttribute('title', 'docs/a.md')
    expect(tab('a.md')).toHaveAttribute('tabindex', '0')
    expect(tab('Files')).toHaveAttribute('tabindex', '-1')
    // A preview tab is in italics
    expect(screen.getByText('b.md')).toHaveClass('italic')
    expect(screen.getByText('a.md')).not.toHaveClass('italic')
  })

  it('the list entry keeps the Tab stop when the tab shown is unknown', () => {
    show({ activeId: 'gone' })
    expect(tab('Files')).toHaveAttribute('tabindex', '0')
    expect(tab('Files')).toHaveAttribute('aria-selected', 'false')
  })

  it('each tab controls the panel, which its id names', () => {
    show({ panelId: 'p' })
    expect(tab('a.md')).toHaveAttribute('id', 'p-tab-a')
    expect(tab('a.md')).toHaveAttribute('aria-controls', 'p')
    expect(tab('Files')).toHaveAttribute('id', 'p-tab-list')
    // The close buttons are for the mouse: a tablist holds only tabs
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('the list entry is selected when no tab shows', () => {
    show({ activeId: null })
    expect(tab('Files')).toHaveAttribute('aria-selected', 'true')
    expect(tab('Files')).toHaveAttribute('tabindex', '0')
  })

  it('a click shows a tab, a double click pins it', () => {
    const p = show()
    fireEvent.click(tab(/^b\.md/))
    expect(p.onActivate).toHaveBeenCalledWith('b')
    fireEvent.doubleClick(tab(/^b\.md/))
    expect(p.onPin).toHaveBeenCalledWith('b')
    fireEvent.click(tab('Files'))
    expect(p.onActivate).toHaveBeenLastCalledWith(null)
  })

  it('the close button and a middle click close a tab', () => {
    const p = show()
    fireEvent.click(screen.getByLabelText('Close c.md'))
    expect(p.onClose).toHaveBeenCalledWith('c')
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 1,
    })
    tab('a.md').dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    fireEvent(
      tab('a.md'),
      new MouseEvent('auxclick', { bubbles: true, button: 1 }),
    )
    expect(p.onClose).toHaveBeenLastCalledWith('a')
    // Another button does nothing
    fireEvent(
      tab('a.md'),
      new MouseEvent('auxclick', { bubbles: true, button: 2 }),
    )
    fireEvent.mouseDown(tab('a.md'), { button: 0 })
    expect(p.onClose).toHaveBeenCalledTimes(2)
  })

  it('arrow keys, Home and End move focus; Enter shows; Delete closes', () => {
    const p = show()
    tab('a.md').focus()
    fireEvent.keyDown(tab('a.md'), { key: 'ArrowRight' })
    expect(tab(/^b\.md/)).toHaveFocus()
    fireEvent.keyDown(tab(/^b\.md/), { key: 'End' })
    expect(tab(/^c\.md/)).toHaveFocus()
    // Wraps around
    fireEvent.keyDown(tab(/^c\.md/), { key: 'ArrowRight' })
    expect(tab('Files')).toHaveFocus()
    fireEvent.keyDown(tab('Files'), { key: 'ArrowLeft' })
    expect(tab(/^c\.md/)).toHaveFocus()
    fireEvent.keyDown(tab(/^c\.md/), { key: 'Home' })
    expect(tab('Files')).toHaveFocus()
    fireEvent.keyDown(tab('Files'), { key: 'Enter' })
    expect(p.onActivate).toHaveBeenLastCalledWith(null)
    // The list entry never closes
    fireEvent.keyDown(tab('Files'), { key: 'Delete' })
    expect(p.onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(tab('a.md'), { key: ' ' })
    expect(p.onActivate).toHaveBeenLastCalledWith('a')
    fireEvent.keyDown(tab('a.md'), { key: 'Delete' })
    expect(p.onClose).toHaveBeenCalledWith('a')
    // Other keys are left alone
    const other = fireEvent.keyDown(tab('a.md'), { key: 'x' })
    expect(other).toBe(true)
  })

  it('scrolls the tab shown into view', () => {
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    const p = show()
    p.rerender(<FileTabBar {...p} activeId="c" />)
    expect(scroll).toHaveBeenLastCalledWith({
      block: 'nearest',
      inline: 'nearest',
    })
    expect(scroll.mock.contexts[scroll.mock.contexts.length - 1]).toBe(
      tab(/^c\.md/),
    )
  })

  it('hides its scrollbar and turns the mouse wheel sideways', () => {
    show()
    const bar = screen.getByRole('tablist', { name: 'Open files' })
    expect(bar).toHaveClass('scrollbar-hide')
    Object.defineProperty(bar, 'clientWidth', { value: 100 })
    Object.defineProperty(bar, 'scrollWidth', { value: 300 })
    fireEvent.wheel(bar, { deltaY: 40 })
    expect(bar.scrollLeft).toBe(40)
  })

  it('strikes through a tab whose file was not found, and says why', () => {
    show({ tabs: [entry('a', { missing: true }), entry('b')] })
    const gone = tab(/^a\.md ?\(not found\)$/)
    expect(gone).toHaveAttribute('title', 'docs/a.md — File not found')
    expect(gone.querySelector('.line-through')).toHaveTextContent('a.md')
    expect(tab('b.md')).toHaveAttribute('title', 'docs/b.md')
  })

  describe('moving a tab', () => {
    // The box around a tab's button, the one that drags
    const box = (name: RegExp) => tab(name).parentElement as HTMLElement
    const A = /^a\.md/
    const B = /^b\.md/
    const C = /^c\.md/
    const slide = (name: RegExp) => box(name).style.translate
    // jsdom lays nothing out: Files spans 0-80, then a 100 px tab each,
    // the bar ending at 400
    const layOut = () => {
      const rect = (left: number, width: number) =>
        ({ left, right: left + width, width, top: 0, bottom: 32 }) as DOMRect
      vi.spyOn(
        screen.getByRole('tablist'),
        'getBoundingClientRect',
      ).mockReturnValue(rect(0, 400))
      ;[A, B, C].forEach((name, i) => {
        vi.spyOn(box(name), 'getBoundingClientRect').mockReturnValue(
          rect(80 + i * 100, 100),
        )
      })
    }
    const press = (el: HTMLElement, clientX: number, init = {}) =>
      fireEvent.pointerDown(el, {
        button: 0,
        pointerType: 'mouse',
        clientX,
        ...init,
      })
    const moveTo = (clientX: number) =>
      fireEvent.pointerMove(window, { clientX })
    const release = () => fireEvent.pointerUp(window)
    afterEach(async () => {
      vi.restoreAllMocks()
      // A drag's swallowed click is let go after its task
      await new Promise((r) => setTimeout(r))
    })

    it('drags a tab along the files, the others making room', async () => {
      const p = show({ onMove: vi.fn() })
      layOut()
      tab(C).focus()
      press(box(C), 330)
      // Under the slop it is still a click
      moveTo(328)
      expect(box(C)).not.toHaveAttribute('data-dragging')
      // Past the first file tab: it stops there, never over Files; its
      // focus ring does not follow it
      moveTo(-100)
      expect(box(C)).toHaveAttribute('data-dragging', 'true')
      expect(slide(C)).toBe('-200px 0')
      expect(document.activeElement).toBe(document.body)
      expect(slide(A)).toBe('100px 0')
      expect(slide(B)).toBe('100px 0')
      // Back past b's middle only
      moveTo(250)
      expect(slide(A)).toBe('')
      expect(slide(B)).toBe('100px 0')
      release()
      expect(p.onMove).toHaveBeenCalledWith('c', 1)
      expect(box(C)).not.toHaveAttribute('data-dragging')
      // Into the new order without sliding there from where each was drawn
      expect(slide(C)).toBe('')
      expect(slide(B)).toBe('')
      expect(box(C).style.transition).toBe('none')
      expect(box(B).style.transition).toBe('none')
      // The click that ends the drag does not show the tab
      fireEvent.click(tab(C))
      expect(p.onActivate).not.toHaveBeenCalled()
      // They slide again from the frame after
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      )
      expect(box(C).style.transition).toBe('')
    })

    it('a cancelled drag slides the tabs back', () => {
      show({ onMove: vi.fn() })
      layOut()
      press(box(A), 100)
      moveTo(300)
      fireEvent.pointerCancel(window)
      expect(slide(A)).toBe('')
      expect(box(A).style.transition).toBe('')
      expect(box(A)).not.toHaveAttribute('data-dragging')
    })

    it('a press released without moving is a click', () => {
      const p = show({ onMove: vi.fn() })
      layOut()
      press(box(B), 200)
      release()
      fireEvent.click(tab(B))
      expect(p.onActivate).toHaveBeenCalledWith('b')
      expect(p.onMove).not.toHaveBeenCalled()
    })

    it('stops at the end of the bar, and a drop in place sends nothing', () => {
      const p = show({ onMove: vi.fn() })
      layOut()
      press(box(A), 100)
      moveTo(900)
      expect(slide(A)).toBe('220px 0')
      moveTo(110)
      release()
      expect(p.onMove).not.toHaveBeenCalled()
    })

    it('Escape or a cancel puts the tab back', () => {
      const p = show({ onMove: vi.fn() })
      layOut()
      // A key before the drag starts is left alone
      press(box(A), 100)
      fireEvent.keyDown(window, { key: 'Escape' })
      moveTo(300)
      fireEvent.keyDown(window, { key: 'x' })
      expect(box(A)).toHaveAttribute('data-dragging', 'true')
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(box(A)).not.toHaveAttribute('data-dragging')
      expect(slide(B)).toBe('')
      release()
      press(box(A), 100)
      moveTo(300)
      fireEvent.pointerCancel(window)
      expect(p.onMove).not.toHaveBeenCalled()
    })

    it('sends nothing when the tabs changed under the drag', () => {
      const p = show({ onMove: vi.fn() })
      layOut()
      press(box(A), 100)
      moveTo(300)
      p.rerender(<FileTabBar {...p} tabs={p.tabs.slice(1)} />)
      release()
      expect(p.onMove).not.toHaveBeenCalled()
    })

    it('does not drag by touch, a right button, the close button, or during a drag', () => {
      const p = show({ onMove: vi.fn() })
      layOut()
      press(box(A), 100, { pointerType: 'touch' })
      moveTo(300)
      press(box(A), 100, { button: 2 })
      moveTo(300)
      const close = box(A).querySelector('button:not([role="tab"])')!
      press(close as HTMLElement, 100)
      moveTo(300)
      expect(box(A)).not.toHaveAttribute('data-dragging')
      press(box(A), 100)
      press(box(B), 200)
      moveTo(300)
      expect(box(A)).toHaveAttribute('data-dragging', 'true')
      expect(box(B)).not.toHaveAttribute('data-dragging')
      release()
      expect(p.onMove).toHaveBeenCalledTimes(1)
    })

    it('stops listening when the bar goes away mid-drag', () => {
      const p = show({ onMove: vi.fn() })
      layOut()
      press(box(A), 100)
      moveTo(300)
      p.unmount()
      moveTo(350)
      release()
      expect(p.onMove).not.toHaveBeenCalled()
    })

    it('does not drag without onMove, nor a single tab', () => {
      const p = show()
      press(box(A), 100)
      moveTo(300)
      expect(box(A)).not.toHaveAttribute('data-dragging')
      release()
      p.unmount()
      const one = show({ tabs: [entry('a')], onMove: vi.fn() })
      press(box(A), 100)
      moveTo(300)
      expect(box(A)).not.toHaveAttribute('data-dragging')
      expect(tab(A)).toHaveAttribute('aria-keyshortcuts', 'Delete')
      release()
      expect(one.onMove).not.toHaveBeenCalled()
    })

    it('Alt+Left/Right moves the focused tab one place', () => {
      const p = show({ onMove: vi.fn() })
      expect(tab(B)).toHaveAttribute(
        'aria-keyshortcuts',
        'Delete Alt+ArrowLeft Alt+ArrowRight',
      )
      fireEvent.keyDown(tab(B), { key: 'ArrowLeft', altKey: true })
      expect(p.onMove).toHaveBeenLastCalledWith('b', 0)
      fireEvent.keyDown(tab(B), { key: 'ArrowRight', altKey: true })
      expect(p.onMove).toHaveBeenLastCalledWith('b', 2)
      // Not past an end, and not the list's entry; focus stays put
      fireEvent.keyDown(tab(A), { key: 'ArrowLeft', altKey: true })
      fireEvent.keyDown(tab(C), { key: 'ArrowRight', altKey: true })
      fireEvent.keyDown(tab('Files'), { key: 'ArrowRight', altKey: true })
      expect(p.onMove).toHaveBeenCalledTimes(2)
    })

    it('Alt+Left/Right does nothing without onMove', () => {
      const p = show()
      tab(B).focus()
      const e = fireEvent.keyDown(tab(B), { key: 'ArrowLeft', altKey: true })
      expect(e).toBe(true)
      expect(document.activeElement).toBe(tab(B))
      expect(p.onActivate).not.toHaveBeenCalled()
    })
  })
})

describe('FileTabBar menu', () => {
  function withMenu() {
    const menuFor = vi.fn((id: string) => (
      <MenuItem onSelect={vi.fn()}>Item of {id}</MenuItem>
    ))
    const view = render(
      <FileTabBar
        tabs={[entry('a'), entry('b', { pinned: false })]}
        activeId="a"
        homeLabel="Files"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onPin={vi.fn()}
        onMove={vi.fn()}
        menuFor={menuFor}
      />,
    )
    return { menuFor, ...view }
  }
  const tabBox = (name: string) =>
    screen.getByRole('tab', { name: new RegExp(`^${name}`) })
      .parentElement as HTMLElement

  it("a right click on a file tab opens its menu, the browser's kept shut", () => {
    withMenu()
    const ev = createEvent.contextMenu(tabBox('b.md'), {
      clientX: 30,
      clientY: 10,
    })
    fireEvent(tabBox('b.md'), ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(screen.getByRole('menu', { name: 'Actions for b.md' }))
    expect(screen.getByRole('menuitem', { name: 'Item of b' }))
    expect(tab(/^b\.md/)).toHaveAttribute(
      'aria-keyshortcuts',
      'Delete Alt+ArrowLeft Alt+ArrowRight Shift+F10',
    )
    // The list's entry has none
    const home = createEvent.contextMenu(tab('Files'))
    fireEvent(tab('Files'), home)
    expect(home.defaultPrevented).toBe(false)
  })

  it('the menu key opens the focused tab’s menu, its first item focused; Escape gives the tab the focus back', () => {
    withMenu()
    fireEvent.keyDown(tab('a.md'), { key: 'F10', shiftKey: true })
    expect(screen.getByRole('menuitem', { name: 'Item of a' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(tab('a.md')).toHaveFocus()
    // Not on the list's entry
    fireEvent.keyDown(tab('Files'), { key: 'ContextMenu' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('a finger resting on a tab opens its menu once', () => {
    vi.useFakeTimers()
    try {
      const { menuFor } = withMenu()
      fireEvent.pointerDown(tabBox('b.md'), {
        pointerType: 'touch',
        button: 0,
      })
      act(() => vi.advanceTimersByTime(LONG_PRESS_MS))
      expect(screen.getByRole('menuitem', { name: 'Item of b' }))
      fireEvent.contextMenu(tabBox('b.md'))
      expect(menuFor.mock.calls.every(([id]) => id === 'b')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('without menuFor, a right click is the browser’s', () => {
    show()
    const ev = createEvent.contextMenu(tab('a.md').parentElement as Element)
    fireEvent(tab('a.md').parentElement as Element, ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(tab('a.md')).toHaveAttribute('aria-keyshortcuts', 'Delete')
  })
})
