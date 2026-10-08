import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileTabBar, type TabEntry, type TabListProps } from './file-tab-bar'

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
})
