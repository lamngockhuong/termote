import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionGroup } from '../types/session'
import { SessionSidebar } from './session-sidebar'

vi.mock('./icon-picker', () => ({
  IconPicker: ({
    value,
    onChange,
  }: {
    value: string
    onChange: (v: string) => void
  }) => (
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

// jsdom has no modal <dialog>; the mobile list is a Sheet.
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

const SESSIONS: Session[] = [
  { id: '1', name: 'Shell', icon: '💻', description: 'Terminal' },
  { id: '2', name: 'Dev', icon: '🔧', description: 'Dev session' },
]

const SINGLE_SESSION: Session[] = [
  { id: '1', name: 'Shell', icon: '💻', description: 'Terminal' },
]

describe('SessionSidebar — desktop expanded (default)', () => {
  let onSelect: (...args: any[]) => any

  let onAdd: (...args: any[]) => any

  let onRemove: (...args: any[]) => any

  let onUpdate: (...args: any[]) => any

  let onToggleCollapse: (...args: any[]) => any

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
    expect(
      screen.getByRole('button', { name: 'Collapse sidebar' }),
    ).toBeInTheDocument()
  })

  it('calls onToggleCollapse when collapse button clicked', () => {
    renderDesktop()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    expect(onToggleCollapse).toHaveBeenCalled()
  })

  it('calls onSelect when session clicked', () => {
    renderDesktop()
    // find "Shell" button (session button, not icon)
    const sessionBtn = screen
      .getAllByRole('button')
      .find(
        (b) => b.textContent?.includes('Shell') && !b.closest('[data-testid]'),
      )!
    fireEvent.click(sessionBtn)
    expect(onSelect).toHaveBeenCalledWith('1')
  })

  it('marks the active session', () => {
    renderDesktop()
    const active = screen.getByRole('button', { current: true })
    expect(active).toHaveTextContent('Shell')
    expect(active.parentElement).toHaveClass('bg-accent-soft')
    const dev = screen.getByText('Dev').closest('button')!
    expect(dev).not.toHaveAttribute('aria-current')
    expect(dev.parentElement).not.toHaveClass('bg-accent-soft')
  })

  it('shows the description in the session title', () => {
    renderDesktop()
    expect(screen.getByTitle('Shell - Terminal')).toBeInTheDocument()
  })

  it('names the hover actions after the session', () => {
    renderDesktop()
    expect(screen.getByRole('button', { name: 'Edit Dev' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Remove Dev' }),
    ).toBeInTheDocument()
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
    expect(
      screen.queryByPlaceholderText('Session name'),
    ).not.toBeInTheDocument()
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
    expect(
      screen.queryByPlaceholderText('Session name'),
    ).not.toBeInTheDocument()
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
    const sessionBtns = screen
      .getAllByRole('button')
      .filter((b) => b.textContent?.includes('Shell') && b.closest('aside'))
    // Double click the session button
    const sessionBtn = sessionBtns.find((b) => b.className.includes('flex-1'))
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
    expect(
      screen.queryByRole('button', { name: 'Save' }),
    ).not.toBeInTheDocument()
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
    const removeBtns = document.querySelectorAll(
      'button[title="Remove session"]',
    )
    expect(removeBtns.length).toBeGreaterThan(0)
  })

  it('remove button hidden when only one session', () => {
    renderDesktop(SINGLE_SESSION)
    const removeBtns = document.querySelectorAll(
      'button[title="Remove session"]',
    )
    expect(removeBtns.length).toBe(0)
  })

  it('calls onRemove when remove button clicked', () => {
    renderDesktop()
    const removeBtns = document.querySelectorAll(
      'button[title="Remove session"]',
    )
    fireEvent.click(removeBtns[0])
    expect(onRemove).toHaveBeenCalledWith('1')
  })
})

describe('SessionSidebar — desktop collapsed', () => {
  let onSelect: (...args: any[]) => any

  let onAdd: (...args: any[]) => any

  let onToggleCollapse: (...args: any[]) => any

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
    expect(
      screen.getByRole('button', { name: 'Expand sidebar' }),
    ).toBeInTheDocument()
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
    expect(activeBtn).toHaveAttribute('aria-current', 'true')
    expect(activeBtn).toHaveClass('bg-accent-soft')
    expect(screen.getByTitle('Dev')).not.toHaveAttribute('aria-current')
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

  it('anchors the agent badge to the session icon in a fixed-size circle', () => {
    renderCollapsed([{ ...SESSIONS[0], agentStatus: 'working' }])
    const circle = screen.getByRole('img', {
      name: 'Agent working',
    }).parentElement!
    expect(circle.className).toContain('size-3.5')
    expect(circle.className).toContain('absolute')
    const icon = circle.parentElement!
    expect(icon.className).toContain('leading-none')
    expect(icon).toHaveTextContent('💻')
  })
})

describe('SessionSidebar — mobile mode', () => {
  let onSelect: (...args: any[]) => any

  let onAdd: (...args: any[]) => any

  let onRemove: (...args: any[]) => any

  let onUpdate: (...args: any[]) => any

  let onClose: (...args: any[]) => any

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

  it('renders the list in a sheet titled Sessions', () => {
    renderMobile()
    expect(screen.getByRole('dialog', { name: 'Sessions' })).toBeInTheDocument()
    expect(document.querySelector('aside')).toBeNull()
  })

  it('renders nothing while closed', () => {
    renderMobile(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('calls onClose on a tap on the scrim', () => {
    renderMobile()
    const dialog = screen.getByRole('dialog')
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onClose when the close button is clicked', () => {
    renderMobile()
    fireEvent.click(screen.getByRole('button', { name: 'Close sessions' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('works without onClose', () => {
    render(
      <SessionSidebar
        sessions={SESSIONS}
        activeId="1"
        onSelect={onSelect}
        onAdd={onAdd}
        onRemove={onRemove}
        isMobile
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close sessions' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
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
    // The header button gives way to the form at the top of the list
    expect(screen.queryByTitle('Add new session')).toBeNull()
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

describe('SessionSidebar — groups', () => {
  const GROUPS: SessionGroup[] = [
    { id: 'w1', name: 'api', agentStatus: 'blocked' },
    { id: 'w2', name: '' },
  ]
  const TABS: Session[] = [
    {
      id: 'w1:t1',
      name: 'agents',
      icon: '📺',
      description: '',
      groupId: 'w1',
      agentStatus: 'blocked',
    },
    { id: 'w1:t2', name: 'shell', icon: '📺', description: '', groupId: 'w1' },
    { id: 'w2:t1', name: 'dev', icon: '📺', description: '', groupId: 'w2' },
  ]

  beforeEach(() => localStorage.clear())

  function renderGroups(overrides = {}) {
    return render(
      <SessionSidebar
        sessions={TABS}
        groups={GROUPS}
        activeId="w1:t1"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onUpdate={vi.fn()}
        {...overrides}
      />,
    )
  }

  it('hides the header for a single group', () => {
    render(
      <SessionSidebar
        sessions={SESSIONS}
        groups={[{ id: 'main', name: 'main' }]}
        activeId="1"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
      />,
    )
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByText('main')).toBeNull()
    expect(screen.getByText('Shell')).toBeInTheDocument()
  })

  it('lists tabs under a header per group, with counts and badges', () => {
    renderGroups()
    const api = screen.getByRole('region', { name: 'api' })
    expect(api).toHaveTextContent('agents')
    expect(api).toHaveTextContent('shell')
    expect(api).not.toHaveTextContent('dev')
    expect(
      screen.getByRole('button', { name: /api.*2/, expanded: true }),
    ).toBeInTheDocument()
    // Group badge and tab badge
    expect(screen.getAllByRole('img', { name: 'Agent blocked' })).toHaveLength(
      2,
    )
    // A group without a name falls back to its id
    expect(screen.getByRole('region', { name: 'w2' })).toHaveTextContent('dev')
  })

  it('collapses one group and remembers it', () => {
    renderGroups()
    fireEvent.click(screen.getByRole('button', { name: /api/ }))
    expect(screen.queryByText('agents')).toBeNull()
    expect(screen.getByText('dev')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /api/, expanded: false }),
    ).toBeInTheDocument()
    expect(
      JSON.parse(localStorage.getItem('termote-group-collapsed')!),
    ).toEqual({ w1: true })
  })

  it('groups swipeable items on mobile', () => {
    renderGroups({ isMobile: true })
    const web = screen.getByRole('region', { name: 'w2' })
    expect(web).toContainElement(screen.getByTestId('swipeable-w2:t1'))
  })

  it('shows tab badges in the icon-only sidebar', () => {
    renderGroups({ isCollapsed: true })
    expect(screen.getByRole('img', { name: 'Agent blocked' })).toBeVisible()
  })
})

describe('SessionSidebar — filter bar', () => {
  const SESSIONS_WITH_AGENTS: Session[] = [
    {
      id: '1',
      name: 'Blocked',
      icon: '🔴',
      description: '',
      panes: [
        { id: 'p1', label: 'p1', hasAgent: true, agentStatus: 'blocked' },
      ],
    },
    {
      id: '2',
      name: 'Working',
      icon: '🟡',
      description: '',
      panes: [
        { id: 'p2', label: 'p2', hasAgent: true, agentStatus: 'working' },
      ],
    },
    {
      id: '3',
      name: 'No agent',
      icon: '💻',
      description: '',
      hasAgent: false,
    },
  ]

  function renderWithFilter(sessions = SESSIONS_WITH_AGENTS, overrides = {}) {
    const onFilterChange = vi.fn()
    const onSelect = vi.fn()
    const onAdd = vi.fn()
    const onRemove = vi.fn()
    const onToggleCollapse = vi.fn()
    return {
      ...render(
        <SessionSidebar
          sessions={sessions}
          activeId="1"
          onSelect={onSelect}
          onAdd={onAdd}
          onRemove={onRemove}
          onToggleCollapse={onToggleCollapse}
          onFilterChange={onFilterChange}
          filter="all"
          {...overrides}
        />,
      ),
      onFilterChange,
    }
  }

  it('hides filter bar when onFilterChange not provided', () => {
    render(
      <SessionSidebar
        sessions={SESSIONS_WITH_AGENTS}
        activeId="1"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onToggleCollapse={vi.fn()}
      />,
    )
    expect(
      screen.queryByRole('radiogroup', { name: 'Filter sessions' }),
    ).not.toBeInTheDocument()
  })

  it('hides filter bar when no session has an agent', () => {
    const noAgentSessions: Session[] = [
      { id: '1', name: 'S1', icon: '💻', description: '', hasAgent: false },
      { id: '2', name: 'S2', icon: '💻', description: '', hasAgent: false },
    ]
    renderWithFilter(noAgentSessions)
    expect(
      screen.queryByRole('radiogroup', { name: 'Filter sessions' }),
    ).not.toBeInTheDocument()
  })

  it('shows filter bar when onFilterChange provided and some session has agent', () => {
    renderWithFilter()
    expect(
      screen.getByRole('radiogroup', { name: 'Filter sessions' }),
    ).toBeInTheDocument()
  })

  it('displays all four filter options', () => {
    renderWithFilter()
    expect(
      screen.getByRole('radio', { name: 'All sessions' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Needs you/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Working/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Agents/ })).toBeInTheDocument()
  })

  it('calls onFilterChange when filter radio clicked', () => {
    const { onFilterChange } = renderWithFilter()
    const needsYouBtn = screen.getByRole('radio', { name: /Needs you/ })
    fireEvent.click(needsYouBtn)
    expect(onFilterChange).toHaveBeenCalledWith('needs-you')
  })

  it('shows only matching sessions when filter is applied', () => {
    renderWithFilter(SESSIONS_WITH_AGENTS, { filter: 'needs-you' })
    expect(screen.getByText('Blocked')).toBeInTheDocument()
    // When a session is not matching, it should not be visible in the main list
  })

  it('shows empty state when no sessions match the filter', () => {
    const onlyBlocked: Session[] = [
      {
        id: '1',
        name: 'Blocked',
        icon: '🔴',
        description: '',
        panes: [
          { id: 'p1', label: 'p1', hasAgent: true, agentStatus: 'blocked' },
        ],
      },
    ]
    renderWithFilter(onlyBlocked, { filter: 'working' })
    expect(screen.getByText('No sessions match')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument()
  })

  it('calls onFilterChange with "all" when Show all button clicked', () => {
    const onlyBlocked: Session[] = [
      {
        id: '1',
        name: 'Blocked',
        icon: '🔴',
        description: '',
        panes: [
          { id: 'p1', label: 'p1', hasAgent: true, agentStatus: 'blocked' },
        ],
      },
    ]
    const { onFilterChange } = renderWithFilter(onlyBlocked, {
      filter: 'working',
    })
    const showAllBtn = screen.getByRole('button', { name: 'Show all' })
    fireEvent.click(showAllBtn)
    expect(onFilterChange).toHaveBeenCalledWith('all')
  })

  it('applies sortBlockedFirst when enabled', () => {
    const sessions: Session[] = [
      {
        id: '3',
        name: 'Working',
        icon: '🟡',
        description: '',
        panes: [
          { id: 'p3', label: 'p3', hasAgent: true, agentStatus: 'working' },
        ],
      },
      {
        id: '1',
        name: 'Blocked',
        icon: '🔴',
        description: '',
        panes: [
          { id: 'p1', label: 'p1', hasAgent: true, agentStatus: 'blocked' },
        ],
      },
      {
        id: '2',
        name: 'Idle',
        icon: '⚪',
        description: '',
        hasAgent: false,
      },
    ]
    renderWithFilter(sessions, { sortBlockedFirst: true })
    const items = screen.getAllByText(/^(Blocked|Working|Idle)$/)
    expect(items[0]).toHaveTextContent('Blocked')
    expect(items[1]).toHaveTextContent('Working')
    expect(items[2]).toHaveTextContent('Idle')
  })

  it('hides group without matches when filtering', () => {
    const GROUPED_SESSIONS: Session[] = [
      {
        id: '1',
        name: 'Blocked in web',
        icon: '🔴',
        description: '',
        groupId: 'web',
        panes: [
          { id: 'p1', label: 'p1', hasAgent: true, agentStatus: 'blocked' },
        ],
      },
      {
        id: '2',
        name: 'Working in app',
        icon: '🟡',
        description: '',
        groupId: 'app',
        panes: [
          { id: 'p2', label: 'p2', hasAgent: true, agentStatus: 'working' },
        ],
      },
    ]
    const GROUPS = [
      { id: 'web', name: 'Web' },
      { id: 'app', name: 'App' },
    ]
    renderWithFilter(GROUPED_SESSIONS, {
      groups: GROUPS,
      filter: 'needs-you',
    })
    // When filtering for 'needs-you' (blocked), only 'web' group with matching session shows
    expect(screen.getByRole('region', { name: 'Web' })).toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: 'App' }),
    ).not.toBeInTheDocument()
  })
  const pane = (id: string, agentStatus: 'blocked' | 'working') => ({
    id,
    label: id,
    hasAgent: true,
    agentStatus,
  })
  const TWO_GROUPS = [
    { id: 'web', name: 'Web' },
    { id: 'app', name: 'App' },
  ]
  const GROUPED: Session[] = [
    {
      id: 'w1',
      name: 'Web working',
      icon: '🟡',
      description: '',
      groupId: 'web',
      panes: [pane('a', 'working')],
    },
    {
      id: 'w2',
      name: 'Web blocked',
      icon: '🔴',
      description: '',
      groupId: 'web',
      panes: [pane('b', 'blocked')],
    },
    {
      id: 'a1',
      name: 'App working',
      icon: '🟢',
      description: '',
      groupId: 'app',
      panes: [pane('c', 'working')],
    },
    {
      id: 'a2',
      name: 'App blocked',
      icon: '🟠',
      description: '',
      groupId: 'app',
      panes: [pane('d', 'blocked')],
    },
  ]

  it('holds a matching group open while filtering and leaves its saved state alone', () => {
    localStorage.setItem(
      'termote-group-collapsed',
      JSON.stringify({ web: true }),
    )
    const { rerender } = renderWithFilter(GROUPED, {
      groups: TWO_GROUPS,
      filter: 'needs-you',
    })
    const header = screen
      .getByRole('region', { name: 'Web' })
      .querySelector('button[aria-expanded]')!
    expect(header).toBeDisabled()
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Web blocked')).toBeInTheDocument()
    fireEvent.click(header)
    expect(
      JSON.parse(localStorage.getItem('termote-group-collapsed')!),
    ).toEqual({ web: true })

    rerender(
      <SessionSidebar
        sessions={GROUPED}
        groups={TWO_GROUPS}
        activeId="w1"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onFilterChange={vi.fn()}
        filter="all"
      />,
    )
    expect(
      screen
        .getByRole('region', { name: 'Web' })
        .querySelector('button[aria-expanded]'),
    ).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Web blocked')).not.toBeInTheDocument()
    localStorage.removeItem('termote-group-collapsed')
  })

  it('clears the filter when a session is added so the new one shows', () => {
    const onAdd = vi.fn()
    const { onFilterChange } = renderWithFilter(SESSIONS_WITH_AGENTS, {
      filter: 'needs-you',
      onAdd,
    })
    fireEvent.click(screen.getByRole('button', { name: /New session/ }))
    const input = screen.getByPlaceholderText('Session name')
    fireEvent.change(input, { target: { value: 'Fresh' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onFilterChange).toHaveBeenCalledWith('all')
    expect(onAdd).toHaveBeenCalledWith('Fresh', '💻')
  })

  it('does not touch the filter when adding without one', () => {
    const { onFilterChange } = renderWithFilter(SESSIONS_WITH_AGENTS)
    fireEvent.click(screen.getByRole('button', { name: /New session/ }))
    const input = screen.getByPlaceholderText('Session name')
    fireEvent.change(input, { target: { value: 'Fresh' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onFilterChange).not.toHaveBeenCalled()
  })

  it('keeps the row being edited when it stops matching', () => {
    const working: Session[] = [
      {
        id: '1',
        name: 'Agent',
        icon: '🟡',
        description: '',
        panes: [pane('p', 'working')],
      },
      {
        id: '2',
        name: 'Other',
        icon: '🔴',
        description: '',
        panes: [pane('q', 'blocked')],
      },
    ]
    const props = {
      groups: [],
      activeId: '1',
      onSelect: vi.fn(),
      onAdd: vi.fn(),
      onRemove: vi.fn(),
      onUpdate: vi.fn(),
      onFilterChange: vi.fn(),
      filter: 'working' as const,
    }
    const { rerender } = render(
      <SessionSidebar sessions={working} {...props} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit Agent' }))
    const done: Session[] = [
      {
        ...working[0],
        panes: [{ id: 'p', label: 'p', hasAgent: true, agentStatus: 'done' }],
      },
      working[1],
    ]
    rerender(<SessionSidebar sessions={done} {...props} />)
    expect(screen.getByRole('textbox', { name: 'Session name' })).toHaveValue(
      'Agent',
    )
  })

  it('ignores a filter given without onFilterChange', () => {
    render(
      <SessionSidebar
        sessions={SESSIONS_WITH_AGENTS}
        activeId="1"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        filter="needs-you"
      />,
    )
    expect(screen.getByText('Working')).toBeInTheDocument()
    expect(screen.getByText('No agent')).toBeInTheDocument()
  })

  it('filters the collapsed rail and marks the expand button', () => {
    renderWithFilter(SESSIONS_WITH_AGENTS, {
      isCollapsed: true,
      filter: 'needs-you',
    })
    expect(
      screen.getByRole('button', { name: 'Expand sidebar, filtered' }),
    ).toBeInTheDocument()
    expect(screen.getByTitle('Blocked')).toBeInTheDocument()
    expect(screen.queryByTitle('Working')).not.toBeInTheDocument()
  })

  it('sorts the collapsed rail blocked first within each group', () => {
    renderWithFilter(GROUPED, {
      groups: TWO_GROUPS,
      isCollapsed: true,
      sortBlockedFirst: true,
    })
    expect(
      screen.getByRole('button', { name: 'Expand sidebar' }),
    ).toBeInTheDocument()
    const titles = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('title'))
      .filter((t) => t?.startsWith('Web ') || t?.startsWith('App '))
    expect(titles).toEqual([
      'Web blocked',
      'Web working',
      'App blocked',
      'App working',
    ])
  })
})
