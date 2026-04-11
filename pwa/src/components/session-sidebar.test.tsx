import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SessionSidebar } from './session-sidebar'
import type { Session } from '../types/session'

vi.mock('./icon-picker', () => ({
  IconPicker: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <button data-testid="icon-picker" onClick={() => onChange('🚀')}>
      {value}
    </button>
  ),
}))

vi.mock('./swipeable-session-item', () => ({
  SwipeableSessionItem: ({
    session,
    isActive,
    onSelect,
    onEdit,
    onRemove,
  }: {
    session: Session
    isActive: boolean
    onSelect: () => void
    onEdit: () => void
    onRemove: () => void
    canRemove: boolean
    canEdit: boolean
  }) => (
    <div data-testid={`swipeable-${session.id}`} data-active={isActive}>
      <span>{session.name}</span>
      <button onClick={onSelect}>Select</button>
      <button onClick={onEdit}>Edit</button>
      <button onClick={onRemove}>Remove</button>
    </div>
  ),
}))

const SESSIONS: Session[] = [
  { id: '1', name: 'Shell', icon: '💻', description: 'Terminal' },
  { id: '2', name: 'Dev', icon: '🔧', description: 'Dev session' },
]

const SINGLE_SESSION: Session[] = [
  { id: '1', name: 'Shell', icon: '💻', description: 'Terminal' },
]

describe('SessionSidebar — desktop expanded (default)', () => {
  let onSelect: ReturnType<typeof vi.fn>
  let onAdd: ReturnType<typeof vi.fn>
  let onRemove: ReturnType<typeof vi.fn>
  let onUpdate: ReturnType<typeof vi.fn>
  let onToggleCollapse: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onSelect = vi.fn()
    onAdd = vi.fn()
    onRemove = vi.fn()
    onUpdate = vi.fn()
    onToggleCollapse = vi.fn()
  })

  function renderDesktop(sessions = SESSIONS, overrides = {}) {
    return render(
      <SessionSidebar
        sessions={sessions}
        activeId="1"
        onSelect={onSelect}
        onAdd={onAdd}
        onRemove={onRemove}
        onUpdate={onUpdate}
        onToggleCollapse={onToggleCollapse}
        {...overrides}
      />,
    )
  }

  it('renders session names in desktop expanded view', () => {
    renderDesktop()
    expect(screen.getByText('Shell')).toBeInTheDocument()
    expect(screen.getByText('Dev')).toBeInTheDocument()
  })

  it('renders collapse button', () => {
    renderDesktop()
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument()
  })

  it('calls onToggleCollapse when collapse button clicked', () => {
    renderDesktop()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(onToggleCollapse).toHaveBeenCalled()
  })

  it('calls onSelect when session clicked', () => {
    renderDesktop()
    // find "Shell" button (session button, not icon)
    const sessionBtn = screen.getAllByRole('button').find(
      (b) => b.textContent?.includes('Shell') && !b.closest('[data-testid]'),
    )!
    fireEvent.click(sessionBtn)
    expect(onSelect).toHaveBeenCalledWith('1')
  })

  it('applies active class to active session', () => {
    renderDesktop()
    // The active session wrapper has ACTIVE_SESSION_CLASSES
    const activeRow = document.querySelector('.border-l-2.border-blue-500')
    expect(activeRow).toBeInTheDocument()
  })

  it('shows Add session button when form is hidden', () => {
    renderDesktop()
    expect(screen.getByTitle('Add new session')).toBeInTheDocument()
  })

  it('shows add form when Add button clicked', () => {
    renderDesktop()
    fireEvent.click(screen.getByTitle('Add new session'))
    expect(screen.getByPlaceholderText('Session name')).toBeInTheDocument()
  })

  it('add form: input updates name', () => {
    renderDesktop()
    fireEvent.click(screen.getByTitle('Add new session'))
    const input = screen.getByPlaceholderText('Session name')
    fireEvent.change(input, { target: { value: 'MySession' } })
    expect((input as HTMLInputElement).value).toBe('MySession')
  })

  it('add form: pressing Enter calls onAdd', () => {
    renderDesktop()
    fireEvent.click(screen.getByTitle('Add new session'))
    const input = screen.getByPlaceholderText('Session name')
    fireEvent.change(input, { target: { value: 'NewSess' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).toHaveBeenCalledWith('NewSess', '💻')
  })

  it('add form: clicking Add button calls onAdd', () => {
    renderDesktop()
    fireEvent.click(screen.getByTitle('Add new session'))
    fireEvent.change(screen.getByPlaceholderText('Session name'), {
      target: { value: 'NewSess' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onAdd).toHaveBeenCalledWith('NewSess', '💻')
  })

  it('add form: does not call onAdd if name is empty', () => {
    renderDesktop()
    fireEvent.click(screen.getByTitle('Add new session'))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('add form: clicking Cancel hides the form', () => {
    renderDesktop()
    fireEvent.click(screen.getByTitle('Add new session'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByPlaceholderText('Session name')).not.toBeInTheDocument()
  })

  it('add form: icon picker changes icon', () => {
    renderDesktop()
    fireEvent.click(screen.getByTitle('Add new session'))
    const iconPicker = screen.getAllByTestId('icon-picker')[0]
    fireEvent.click(iconPicker)
    // Icon changed to 🚀 — now add
    fireEvent.change(screen.getByPlaceholderText('Session name'), {
      target: { value: 'Rocket' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onAdd).toHaveBeenCalledWith('Rocket', '🚀')
  })

  it('add form: resets state after successful add', () => {
    renderDesktop()
    fireEvent.click(screen.getByTitle('Add new session'))
    fireEvent.change(screen.getByPlaceholderText('Session name'), {
      target: { value: 'Temp' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    // Form should be hidden
    expect(screen.queryByPlaceholderText('Session name')).not.toBeInTheDocument()
  })

  it('edit form: starts edit via edit button hover action', () => {
    renderDesktop()
    // Find edit pencil button (hidden group-hover button)
    const editBtns = document.querySelectorAll('button[title="Edit session"]')
    expect(editBtns.length).toBeGreaterThan(0)
    fireEvent.click(editBtns[0])
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('edit form: double-click on session starts edit', () => {
    renderDesktop()
    const sessionBtns = screen.getAllByRole('button').filter(
      (b) => b.textContent?.includes('Shell') && b.closest('aside'),
    )
    // Double click the session button
    const sessionBtn = sessionBtns.find(b => b.className.includes('flex-1'))
    if (sessionBtn) {
      fireEvent.doubleClick(sessionBtn)
      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
    }
  })

  it('edit form: updates name input', () => {
    renderDesktop()
    const editBtns = document.querySelectorAll('button[title="Edit session"]')
    fireEvent.click(editBtns[0])
    const input = screen.getByDisplayValue('Shell')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    expect((input as HTMLInputElement).value).toBe('Renamed')
  })

  it('edit form: Save calls onUpdate', () => {
    renderDesktop()
    const editBtns = document.querySelectorAll('button[title="Edit session"]')
    fireEvent.click(editBtns[0])
    const input = screen.getByDisplayValue('Shell')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onUpdate).toHaveBeenCalledWith('1', { name: 'Renamed', icon: '💻' })
  })

  it('edit form: Save does nothing if name is empty', () => {
    renderDesktop()
    const editBtns = document.querySelectorAll('button[title="Edit session"]')
    fireEvent.click(editBtns[0])
    const input = screen.getByDisplayValue('Shell')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('edit form: Save does nothing if onUpdate not provided', () => {
    renderDesktop(SESSIONS, { onUpdate: undefined })
    // With no onUpdate, double-click does nothing (no edit buttons visible without onUpdate)
    const editBtns = document.querySelectorAll('button[title="Edit session"]')
    expect(editBtns.length).toBe(0)
  })

  it('edit form: Cancel hides edit form', () => {
    renderDesktop()
    const editBtns = document.querySelectorAll('button[title="Edit session"]')
    fireEvent.click(editBtns[0])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('edit form: icon picker changes icon', () => {
    renderDesktop()
    const editBtns = document.querySelectorAll('button[title="Edit session"]')
    fireEvent.click(editBtns[0])
    const iconPickers = screen.getAllByTestId('icon-picker')
    fireEvent.click(iconPickers[0]) // changes to 🚀
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onUpdate).toHaveBeenCalledWith('1', { name: 'Shell', icon: '🚀' })
  })

  it('remove button shown when sessions.length > 1', () => {
    renderDesktop()
    const removeBtns = document.querySelectorAll('button[title="Remove session"]')
    expect(removeBtns.length).toBeGreaterThan(0)
  })

  it('remove button hidden when only one session', () => {
    renderDesktop(SINGLE_SESSION)
    const removeBtns = document.querySelectorAll('button[title="Remove session"]')
    expect(removeBtns.length).toBe(0)
  })

  it('calls onRemove when remove button clicked', () => {
    renderDesktop()
    const removeBtns = document.querySelectorAll('button[title="Remove session"]')
    fireEvent.click(removeBtns[0])
    expect(onRemove).toHaveBeenCalledWith('1')
  })
})

describe('SessionSidebar — desktop collapsed', () => {
  let onSelect: ReturnType<typeof vi.fn>
  let onAdd: ReturnType<typeof vi.fn>
  let onToggleCollapse: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onSelect = vi.fn()
    onAdd = vi.fn()
    onToggleCollapse = vi.fn()
  })

  function renderCollapsed(sessions = SESSIONS) {
    return render(
      <SessionSidebar
        sessions={sessions}
        activeId="1"
        onSelect={onSelect}
        onAdd={onAdd}
        onRemove={vi.fn()}
        isCollapsed={true}
        onToggleCollapse={onToggleCollapse}
      />,
    )
  }

  it('renders expand button in collapsed mode', () => {
    renderCollapsed()
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
  })

  it('calls onToggleCollapse when expand button clicked', () => {
    renderCollapsed()
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
    expect(onToggleCollapse).toHaveBeenCalled()
  })

  it('renders session icons in collapsed mode', () => {
    renderCollapsed()
    expect(screen.getByText('💻')).toBeInTheDocument()
    expect(screen.getByText('🔧')).toBeInTheDocument()
  })

  it('calls onSelect when collapsed session icon clicked', () => {
    renderCollapsed()
    // session buttons — find by title
    const sessionBtn = screen.getByTitle('Shell')
    fireEvent.click(sessionBtn)
    expect(onSelect).toHaveBeenCalledWith('1')
  })

  it('applies active class to active session in collapsed mode', () => {
    renderCollapsed()
    const activeBtn = screen.getByTitle('Shell')
    expect(activeBtn.className).toContain('border-blue-500')
  })

  it('collapsed add button expands sidebar and shows add form', () => {
    renderCollapsed()
    const addBtn = screen.getByTitle('Add new session')
    fireEvent.click(addBtn)
    expect(onToggleCollapse).toHaveBeenCalled()
  })

  it('calls onToggleCollapse with undefined gracefully', () => {
    render(
      <SessionSidebar
        sessions={SESSIONS}
        activeId="1"
        onSelect={onSelect}
        onAdd={onAdd}
        onRemove={vi.fn()}
        isCollapsed={true}
        // No onToggleCollapse
      />,
    )
    // Should not throw
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
  })
})

describe('SessionSidebar — mobile mode', () => {
  let onSelect: ReturnType<typeof vi.fn>
  let onAdd: ReturnType<typeof vi.fn>
  let onRemove: ReturnType<typeof vi.fn>
  let onUpdate: ReturnType<typeof vi.fn>
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onSelect = vi.fn()
    onAdd = vi.fn()
    onRemove = vi.fn()
    onUpdate = vi.fn()
    onClose = vi.fn()
  })

  function renderMobile(isOpen = true, sessions = SESSIONS) {
    return render(
      <SessionSidebar
        sessions={sessions}
        activeId="1"
        onSelect={onSelect}
        onAdd={onAdd}
        onRemove={onRemove}
        onUpdate={onUpdate}
        isMobile={true}
        isOpen={isOpen}
        onClose={onClose}
      />,
    )
  }

  it('renders mobile slide-over aside', () => {
    renderMobile()
    expect(screen.getByText('Sessions')).toBeInTheDocument()
  })

  it('shows backdrop when isOpen is true', () => {
    renderMobile(true)
    const backdrop = document.querySelector('.fixed.inset-0.bg-black\\/50')
    expect(backdrop).toBeInTheDocument()
  })

  it('hides backdrop when isOpen is false', () => {
    renderMobile(false)
    const backdrop = document.querySelector('.fixed.inset-0.bg-black\\/50')
    expect(backdrop).not.toBeInTheDocument()
  })

  it('panel slides in when isOpen is true', () => {
    renderMobile(true)
    const panel = document.querySelector('aside')!
    expect(panel.className).toContain('translate-x-0')
  })

  it('panel slides out when isOpen is false', () => {
    renderMobile(false)
    const panel = document.querySelector('aside')!
    expect(panel.className).toContain('-translate-x-full')
  })

  it('calls onClose when backdrop clicked', () => {
    renderMobile()
    const backdrop = document.querySelector('.fixed.inset-0.bg-black\\/50')!
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when X button clicked', () => {
    renderMobile()
    // There's an X button in the mobile header
    const xBtn = screen.getAllByRole('button').find(
      (b) => b.className.includes('rounded-lg') && b.closest('.border-b'),
    )!
    fireEvent.click(xBtn)
    expect(onClose).toHaveBeenCalled()
  })

  it('renders SwipeableSessionItem for each session', () => {
    renderMobile()
    expect(screen.getByTestId('swipeable-1')).toBeInTheDocument()
    expect(screen.getByTestId('swipeable-2')).toBeInTheDocument()
  })

  it('marks active session in swipeable item', () => {
    renderMobile()
    const item = screen.getByTestId('swipeable-1')
    expect(item.getAttribute('data-active')).toBe('true')
  })

  it('onSelect callback from SwipeableSessionItem calls parent onSelect', () => {
    renderMobile()
    const item = screen.getByTestId('swipeable-1')
    fireEvent.click(item.querySelector('button')!) // "Select"
    expect(onSelect).toHaveBeenCalledWith('1')
  })

  it('onEdit callback from SwipeableSessionItem starts edit form', () => {
    renderMobile()
    const item = screen.getByTestId('swipeable-1')
    const editBtn = Array.from(item.querySelectorAll('button')).find(
      (b) => b.textContent === 'Edit',
    )!
    fireEvent.click(editBtn)
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('onRemove callback from SwipeableSessionItem calls onRemove', () => {
    renderMobile()
    const item = screen.getByTestId('swipeable-1')
    const removeBtn = Array.from(item.querySelectorAll('button')).find(
      (b) => b.textContent === 'Remove',
    )!
    fireEvent.click(removeBtn)
    expect(onRemove).toHaveBeenCalledWith('1')
  })

  it('shows Add session button in mobile mode', () => {
    renderMobile()
    expect(screen.getByTitle('Add new session')).toBeInTheDocument()
  })

  it('add form works in mobile mode', () => {
    renderMobile()
    fireEvent.click(screen.getByTitle('Add new session'))
    fireEvent.change(screen.getByPlaceholderText('Session name'), {
      target: { value: 'Mobile Session' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onAdd).toHaveBeenCalledWith('Mobile Session', '💻')
  })

  it('mobile edit form: Save calls onUpdate', () => {
    renderMobile()
    const item = screen.getByTestId('swipeable-1')
    const editBtn = Array.from(item.querySelectorAll('button')).find(
      (b) => b.textContent === 'Edit',
    )!
    fireEvent.click(editBtn)
    const input = screen.getByDisplayValue('Shell')
    fireEvent.change(input, { target: { value: 'Updated' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onUpdate).toHaveBeenCalledWith('1', { name: 'Updated', icon: '💻' })
  })
})
