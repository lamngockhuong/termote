import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { IconPicker } from './icon-picker'

describe('IconPicker', () => {
  it('renders trigger button with current value', () => {
    render(<IconPicker value="💻" onChange={vi.fn()} />)
    expect(screen.getByTitle('Change icon')).toBeInTheDocument()
    expect(screen.getByTitle('Change icon')).toHaveTextContent('💻')
  })

  it('modal is not shown initially', () => {
    render(<IconPicker value="💻" onChange={vi.fn()} />)
    expect(screen.queryByText('Choose Icon')).not.toBeInTheDocument()
  })

  it('opens modal on trigger click', () => {
    render(<IconPicker value="💻" onChange={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Change icon'))
    expect(screen.getByText('Choose Icon')).toBeInTheDocument()
  })

  it('closes modal on Cancel button click', () => {
    render(<IconPicker value="💻" onChange={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Change icon'))
    expect(screen.getByText('Choose Icon')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Choose Icon')).not.toBeInTheDocument()
  })

  it('closes modal on backdrop click', () => {
    const { container } = render(<IconPicker value="💻" onChange={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Change icon'))
    expect(screen.getByText('Choose Icon')).toBeInTheDocument()
    // The backdrop is the fixed inset-0 div
    const backdrop = container.querySelector('.fixed.inset-0.bg-black\\/50')
    expect(backdrop).toBeInTheDocument()
    fireEvent.click(backdrop!)
    expect(screen.queryByText('Choose Icon')).not.toBeInTheDocument()
  })

  it('calls onChange and closes modal on icon selection', () => {
    const onChange = vi.fn()
    render(<IconPicker value="💻" onChange={onChange} />)
    fireEvent.click(screen.getByTitle('Change icon'))
    // Find the 🤖 icon button inside the modal grid
    const iconButtons = screen.getAllByRole('button')
    // 🤖 is the second icon in the ICONS array
    const robotBtn = iconButtons.find((b) => b.textContent === '🤖')
    expect(robotBtn).toBeDefined()
    fireEvent.click(robotBtn!)
    expect(onChange).toHaveBeenCalledWith('🤖')
    expect(screen.queryByText('Choose Icon')).not.toBeInTheDocument()
  })

  it('applies selected styling to current value icon', () => {
    render(<IconPicker value="🚀" onChange={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Change icon'))
    // The 🚀 button inside the grid should have ring-2 class (selected)
    const allButtons = screen.getAllByRole('button')
    const rocketBtn = allButtons.find(
      (b) => b.textContent === '🚀' && b.classList.contains('ring-2'),
    )
    expect(rocketBtn).toBeInTheDocument()
  })

  it('selecting currently selected icon still calls onChange', () => {
    const onChange = vi.fn()
    render(<IconPicker value="💻" onChange={onChange} />)
    fireEvent.click(screen.getByTitle('Change icon'))
    const allButtons = screen.getAllByRole('button')
    // Find laptop button in grid (not the trigger button)
    const laptopBtns = allButtons.filter((b) => b.textContent === '💻')
    // The modal grid button (not the trigger)
    fireEvent.click(laptopBtns[laptopBtns.length - 1])
    expect(onChange).toHaveBeenCalledWith('💻')
  })
})
