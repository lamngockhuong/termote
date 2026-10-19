import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SearchToggle, SessionSearchField } from './session-search-field'

function renderField(value = '', autoFocus?: boolean) {
  const props = {
    autoFocus,
    id: 'search',
    label: 'Find a session',
    value,
    onChange: vi.fn(),
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    onArrowDown: vi.fn(),
  }
  render(<SessionSearchField {...props} />)
  return { ...props, input: screen.getByRole('searchbox') }
}

describe('SessionSearchField', () => {
  it('takes focus when it appears', () => {
    const { input } = renderField()
    expect(input).toHaveFocus()
    expect(input).toHaveAccessibleName('Find a session')
  })

  it('leaves focus alone when asked to', () => {
    const { input } = renderField('', false)
    expect(input).not.toHaveFocus()
  })

  it('leaves keys that end an IME composition to the IME', () => {
    const { input, onChange, onSubmit } = renderField('nihon')
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports what is typed', () => {
    const { input, onChange } = renderField()
    fireEvent.change(input, { target: { value: 'api' } })
    expect(onChange).toHaveBeenCalledWith('api')
  })

  it('Esc clears a query and is handled', () => {
    const { input, onChange, onClose } = renderField('api')
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(event)
    expect(onChange).toHaveBeenCalledWith('')
    expect(onClose).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('Esc on an empty box closes it', () => {
    const { input, onClose } = renderField()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('Enter submits, ArrowDown moves to the list', () => {
    const { input, onSubmit, onArrowDown } = renderField('a')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(onSubmit).toHaveBeenCalled()
    expect(onArrowDown).toHaveBeenCalled()
  })

  it('leaves other keys alone', () => {
    const { input } = renderField()
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('the clear button clears a query and keeps focus', () => {
    const { input, onChange, onClose } = renderField('api')
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }))
    expect(onChange).toHaveBeenCalledWith('')
    expect(onClose).not.toHaveBeenCalled()
    expect(input).toHaveFocus()
  })

  it('the button closes an empty box', () => {
    const { onClose } = renderField()
    fireEvent.click(screen.getByRole('button', { name: 'Close the search' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('SearchToggle', () => {
  it('names the box it opens only while open', () => {
    const onToggle = vi.fn()
    const { rerender } = render(
      <SearchToggle
        controls="search"
        noun="sessions"
        open={false}
        onToggle={onToggle}
      />,
    )
    const closed = screen.getByRole('button', { name: 'Search sessions' })
    expect(closed).toHaveAttribute('aria-expanded', 'false')
    expect(closed).not.toHaveAttribute('aria-controls')
    fireEvent.click(closed)
    expect(onToggle).toHaveBeenCalled()
    rerender(
      <SearchToggle
        controls="search"
        noun="sessions"
        open
        onToggle={onToggle}
      />,
    )
    const open = screen.getByRole('button', { name: 'Close the search' })
    expect(open).toHaveAttribute('aria-expanded', 'true')
    expect(open).toHaveAttribute('aria-controls', 'search')
  })
})
