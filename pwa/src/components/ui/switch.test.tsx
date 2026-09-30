import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Switch } from './switch'

describe('Switch', () => {
  it('reports its state and flips it on click', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <Switch checked={false} onChange={onChange} label="Haptics" />,
    )
    const sw = screen.getByRole('switch', { name: 'Haptics' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    expect(sw).toHaveClass('bg-border-strong')
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)

    rerender(<Switch checked onChange={onChange} label="Haptics" />)
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(sw).toHaveClass('bg-accent')
    fireEvent.click(sw)
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it('takes its name from a visible label', () => {
    render(
      <>
        <span id="lbl">Show tabs</span>
        <Switch checked onChange={vi.fn()} labelledBy="lbl" />
      </>,
    )
    expect(
      screen.getByRole('switch', { name: 'Show tabs' }),
    ).toBeInTheDocument()
  })

  it('does nothing when disabled', () => {
    const onChange = vi.fn()
    render(<Switch checked onChange={onChange} label="X" disabled />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
