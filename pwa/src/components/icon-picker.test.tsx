import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IconPicker } from './icon-picker'

describe('IconPicker', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
  })

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
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText('Choose Icon')).not.toBeInTheDocument()
  })

  it('closes modal on backdrop click', () => {
    render(<IconPicker value="💻" onChange={vi.fn()} />)
    fireEvent.click(screen.getByTitle('Change icon'))
    expect(screen.getByText('Choose Icon')).toBeInTheDocument()
    // A press on the dialog element itself is a press on its scrim
    const dialog = screen.getByRole('dialog')
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
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
    // The 🚀 button inside the grid is marked as the current one
    const rocketBtn = screen.getByRole('button', { name: '🚀', pressed: true })
    expect(rocketBtn).toHaveClass('ring-accent')
    expect(
      screen.getByRole('button', { name: '💻', pressed: false }),
    ).not.toHaveClass('ring-2')
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
