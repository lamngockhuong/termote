import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { InlineCellEditor } from './inline-cell-editor'

function mount(value = 'old') {
  const props = {
    onCommit: vi.fn(),
    onCancel: vi.fn(),
    onExpand: vi.fn(),
  }
  const view = render(
    <InlineCellEditor value={value} label="Edit note, row 2" {...props} />,
  )
  const box = screen.getByRole('textbox', { name: 'Edit note, row 2' })
  return { ...props, ...view, box }
}

const type = (box: HTMLElement, value: string) =>
  fireEvent.change(box, { target: { value } })

describe('InlineCellEditor', () => {
  it('takes the focus with the value selected', () => {
    const { box } = mount('hello')
    expect(box).toHaveFocus()
    expect(box).toHaveValue('hello')
    const field = box as HTMLTextAreaElement
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5])
  })

  it('Enter sets the value, once', () => {
    const p = mount()
    type(p.box, 'new')
    fireEvent.keyDown(p.box, { key: 'Enter' })
    fireEvent.keyDown(p.box, { key: 'Enter' })
    fireEvent.blur(p.box)
    p.unmount()
    expect(p.onCommit).toHaveBeenCalledTimes(1)
    expect(p.onCommit).toHaveBeenCalledWith('new')
  })

  it('Shift+Enter and Alt+Enter break the line, not end it', () => {
    const p = mount()
    expect(fireEvent.keyDown(p.box, { key: 'Enter', shiftKey: true })).toBe(
      true,
    )
    expect(fireEvent.keyDown(p.box, { key: 'Enter', altKey: true })).toBe(true)
    expect(p.onCommit).not.toHaveBeenCalled()
  })

  it('a key ending a word being composed is the composer’s', () => {
    const p = mount()
    fireEvent.keyDown(p.box, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(p.box, { key: 'Escape', isComposing: true })
    expect(p.onCommit).not.toHaveBeenCalled()
    expect(p.onCancel).not.toHaveBeenCalled()
  })

  it('Escape drops what was typed; unmounting then sets nothing', () => {
    const p = mount()
    type(p.box, 'new')
    // Taken: never a maximized panel's Escape
    expect(fireEvent.keyDown(p.box, { key: 'Escape' })).toBe(false)
    p.unmount()
    expect(p.onCancel).toHaveBeenCalledTimes(1)
    expect(p.onCommit).not.toHaveBeenCalled()
  })

  it('Tab and Shift+Tab set the value and move on', () => {
    const one = mount()
    type(one.box, 'a')
    expect(fireEvent.keyDown(one.box, { key: 'Tab' })).toBe(false)
    expect(one.onCommit).toHaveBeenCalledWith('a', 'next')
    one.unmount()
    const two = mount()
    fireEvent.keyDown(two.box, { key: 'Tab', shiftKey: true })
    expect(two.onCommit).toHaveBeenCalledWith('old', 'prev')
  })

  it('Ctrl+S or Cmd+S sets the value, to be saved', () => {
    const one = mount()
    type(one.box, 'a')
    expect(fireEvent.keyDown(one.box, { key: 's', ctrlKey: true })).toBe(false)
    expect(one.onCommit).toHaveBeenCalledWith('a', undefined, true)
    one.unmount()
    const two = mount()
    fireEvent.keyDown(two.box, { key: 'S', metaKey: true })
    expect(two.onCommit).toHaveBeenCalledWith('old', undefined, true)
  })

  it('other keys are the field’s', () => {
    const p = mount()
    for (const key of ['ArrowDown', 'a', 'z']) {
      expect(fireEvent.keyDown(p.box, { key })).toBe(true)
    }
    fireEvent.keyDown(p.box, { key: 'z', ctrlKey: true })
    expect(p.onCommit).not.toHaveBeenCalled()
  })

  it('leaving the field sets the value', () => {
    const p = mount()
    type(p.box, 'left')
    p.box.blur()
    expect(p.onCommit).toHaveBeenCalledWith('left')
  })

  it('keeps it while the window, not the field, loses the focus', () => {
    const p = mount()
    // The field is still the active element: another app took the focus
    fireEvent.blur(p.box)
    expect(p.onCommit).not.toHaveBeenCalled()
  })

  it('scrolled away (unmounted), it sets the last value typed', () => {
    const p = mount()
    type(p.box, 'away')
    p.unmount()
    expect(p.onCommit).toHaveBeenCalledWith('away')
  })

  it('opens the value typed in the sheet, keeping the focus meanwhile', () => {
    const p = mount()
    type(p.box, 'longer')
    const expand = screen.getByRole('button', { name: 'Open in sheet' })
    expect(expand).toHaveAttribute('tabindex', '-1')
    expect(fireEvent.mouseDown(expand)).toBe(false)
    fireEvent.click(expand)
    p.unmount()
    expect(p.onExpand).toHaveBeenCalledWith('longer')
    expect(p.onCommit).not.toHaveBeenCalled()
  })
})
