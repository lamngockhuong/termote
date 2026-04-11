import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryCommand } from '../hooks/use-command-history'
import { CommandHistoryDropdown } from './command-history-dropdown'

const HISTORY: HistoryCommand[] = [
  { id: '1', text: 'git status', timestamp: 1000 },
  { id: '2', text: 'git log', timestamp: 2000 },
  { id: '3', text: 'npm install', timestamp: 3000 },
]

describe('CommandHistoryDropdown', () => {
  const defaultProps = {
    history: HISTORY,
    onSelect: vi.fn(),
    onRemove: vi.fn(),
    onClear: vi.fn(),
    onClose: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('renders search input', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    expect(screen.getByLabelText('Search command history')).toBeInTheDocument()
  })

  it('renders all history items', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    expect(screen.getByText('git status')).toBeInTheDocument()
    expect(screen.getByText('git log')).toBeInTheDocument()
    expect(screen.getByText('npm install')).toBeInTheDocument()
  })

  it('renders clear all button when history exists', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    expect(screen.getByText('Clear all history')).toBeInTheDocument()
  })

  it('does not render clear all button when history is empty', () => {
    render(<CommandHistoryDropdown {...defaultProps} history={[]} />)
    expect(screen.queryByText('Clear all history')).not.toBeInTheDocument()
  })

  it('shows "No command history" when history is empty', () => {
    render(<CommandHistoryDropdown {...defaultProps} history={[]} />)
    expect(screen.getByText('No command history')).toBeInTheDocument()
  })

  it('calls onClose when close button clicked', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Close history'))
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onSelect when history item clicked', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    fireEvent.click(screen.getByText('git status'))
    expect(defaultProps.onSelect).toHaveBeenCalledWith('git status')
  })

  it('calls onClear when clear all button clicked', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    fireEvent.click(screen.getByText('Clear all history'))
    expect(defaultProps.onClear).toHaveBeenCalledTimes(1)
  })

  it('calls onRemove with id when remove button clicked', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Remove command: git status'))
    expect(defaultProps.onRemove).toHaveBeenCalledWith('1')
  })

  it('stopPropagation on remove button prevents onSelect', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    fireEvent.click(screen.getByLabelText('Remove command: git status'))
    expect(defaultProps.onSelect).not.toHaveBeenCalled()
  })

  it('filters history on search input', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    fireEvent.change(screen.getByLabelText('Search command history'), {
      target: { value: 'git' },
    })
    expect(screen.getByText('git status')).toBeInTheDocument()
    expect(screen.getByText('git log')).toBeInTheDocument()
    expect(screen.queryByText('npm install')).not.toBeInTheDocument()
  })

  it('shows "No matching commands" when search has no results', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    fireEvent.change(screen.getByLabelText('Search command history'), {
      target: { value: 'zzz' },
    })
    expect(screen.getByText('No matching commands')).toBeInTheDocument()
  })

  it('filter is case-insensitive', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    fireEvent.change(screen.getByLabelText('Search command history'), {
      target: { value: 'GIT' },
    })
    expect(screen.getByText('git status')).toBeInTheDocument()
    expect(screen.getByText('git log')).toBeInTheDocument()
  })

  it('resets filtered list when search is cleared', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const input = screen.getByLabelText('Search command history')
    fireEvent.change(input, { target: { value: 'git' } })
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByText('npm install')).toBeInTheDocument()
  })

  // Keyboard navigation
  it('ArrowDown moves selection down', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const container =
      screen
        .getByLabelText('Search command history')
        .closest('div[onKeyDown]') ??
      document.querySelector('[role="listbox"]')!.parentElement!
    fireEvent.keyDown(container, { key: 'ArrowDown' })
    // First item (index 0) should be selected
    expect(screen.getByRole('option', { name: /git status/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('ArrowDown stops at last item', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const wrapper =
      document.querySelector('[onkeydown]') ??
      screen.getByLabelText('Search command history').closest('div')!
        .parentElement!
    // Press down 10 times - should stop at last (index 2)
    for (let i = 0; i < 10; i++) {
      fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
    }
    const options = screen.getAllByRole('option')
    expect(options[options.length - 1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
  })

  it('ArrowUp moves selection up', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const wrapper = screen
      .getByLabelText('Search command history')
      .closest('div')!.parentElement!
    fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
    fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
    fireEvent.keyDown(wrapper, { key: 'ArrowUp' })
    // Should be back at index 0
    expect(screen.getAllByRole('option')[0]).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('ArrowUp does not go below -1 (no selection)', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const wrapper = screen
      .getByLabelText('Search command history')
      .closest('div')!.parentElement!
    // No selection yet — pressing up should stay at -1
    fireEvent.keyDown(wrapper, { key: 'ArrowUp' })
    const options = screen.getAllByRole('option')
    for (const opt of options) {
      expect(opt).toHaveAttribute('aria-selected', 'false')
    }
  })

  it('Enter selects highlighted item', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const wrapper = screen
      .getByLabelText('Search command history')
      .closest('div')!.parentElement!
    fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
    fireEvent.keyDown(wrapper, { key: 'Enter' })
    expect(defaultProps.onSelect).toHaveBeenCalledWith('git status')
  })

  it('Enter does nothing when no item selected', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const wrapper = screen
      .getByLabelText('Search command history')
      .closest('div')!.parentElement!
    fireEvent.keyDown(wrapper, { key: 'Enter' })
    expect(defaultProps.onSelect).not.toHaveBeenCalled()
  })

  it('Escape calls onClose', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const wrapper = screen
      .getByLabelText('Search command history')
      .closest('div')!.parentElement!
    fireEvent.keyDown(wrapper, { key: 'Escape' })
    expect(defaultProps.onClose).toHaveBeenCalledTimes(1)
  })

  it('scrolls selected item into view', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const wrapper = screen
      .getByLabelText('Search command history')
      .closest('div')!.parentElement!
    fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('resets selectedIndex when filtered list shrinks below current index', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const wrapper = screen
      .getByLabelText('Search command history')
      .closest('div')!.parentElement!
    // Navigate to index 2
    fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
    fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
    fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
    // Now filter to 1 result — selectedIndex 2 >= length 1, resets to -1
    fireEvent.change(screen.getByLabelText('Search command history'), {
      target: { value: 'npm' },
    })
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
  })

  it('updates aria-activedescendant when item selected', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const wrapper = screen
      .getByLabelText('Search command history')
      .closest('div')!.parentElement!
    fireEvent.keyDown(wrapper, { key: 'ArrowDown' })
    const input = screen.getByLabelText('Search command history')
    expect(input).toHaveAttribute('aria-activedescendant', 'history-item-0')
  })

  it('aria-activedescendant is undefined when no selection', () => {
    render(<CommandHistoryDropdown {...defaultProps} />)
    const input = screen.getByLabelText('Search command history')
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })
})
