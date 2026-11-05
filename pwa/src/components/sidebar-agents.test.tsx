import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOW_TICK } from '../hooks/use-now'
import type { Session, SessionGroup, SessionPane } from '../types/session'
import {
  AGENTS_HEIGHT_DEFAULT,
  AGENTS_HEIGHT_MIN,
  AGENTS_HEIGHT_STEP,
  SidebarAgents,
} from './sidebar-agents'

const NOW = Date.parse('2026-11-05T10:00:00Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

const pane = (id: string, over: Partial<SessionPane> = {}): SessionPane => ({
  id,
  label: id,
  hasAgent: true,
  ...over,
})
const tab = (id: string, groupId: string, panes: SessionPane[]): Session => ({
  id,
  name: id,
  icon: '',
  description: '',
  groupId,
  panes,
})
const GROUPS: SessionGroup[] = [
  { id: 'g1', name: 'api' },
  { id: 'g2', name: '' },
]
const SESSIONS = [
  tab('compile', 'g1', [
    pane('p-work', { agentStatus: 'working', agentSince: ago(3) }),
    pane('p-shell', { hasAgent: false }),
  ]),
  tab('review', 'g2', [
    pane('p-block', {
      agentStatus: 'blocked',
      agentSince: ago(90),
      agentSinceFirstSeen: true,
    }),
  ]),
  tab('docs', 'g1', [pane('p-new')]),
]

const renderAgents = (
  over: Partial<Parameters<typeof SidebarAgents>[0]> = {},
) => {
  const onOpen = vi.fn()
  const view = render(
    <div>
      <SidebarAgents
        sessions={SESSIONS}
        groups={GROUPS}
        clockOffset={0}
        onOpen={onOpen}
        {...over}
      />
    </div>,
  )
  return { ...view, onOpen }
}
const agents = () => screen.getByRole('region', { name: 'Running agents' })
const toggle = () => within(agents()).getByRole('button', { name: /Agents/ })
const handle = () =>
  screen.getByRole('separator', { name: 'Resize the agents' })
const height = () => agents().style.height
const px = (n: number) => `${n}px`

describe('SidebarAgents', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('shows nothing while no agent runs', () => {
    const { container } = renderAgents({
      sessions: [tab('t', 'g1', [pane('p', { hasAgent: false })])],
    })
    expect(container.firstElementChild).toBeEmptyDOMElement()
  })

  it('lists the agents by status, those waiting on the user first', () => {
    renderAgents()
    expect(
      within(agents())
        .getAllByRole('region')
        .map((r) => r.getAttribute('aria-label')),
    ).toEqual(['Needs you', 'Working', 'Idle'])
    expect(toggle()).toHaveTextContent('3')
    const status = (name: string) =>
      within(agents()).getByRole('region', { name })
    // The group's id stands for a group without a name; ≥ for an agent
    // first seen in its state
    expect(status('Needs you')).toHaveTextContent('g2 · review≥ 1 h ago')
    expect(status('Working')).toHaveTextContent('api · compile3 min ago')
    // No time for an agent whose state has no start
    expect(status('Idle')).toHaveTextContent(/^Idle1api · docs$/)
  })

  it('names the tab alone with one group, or for a tab in none', () => {
    const { unmount } = renderAgents({ groups: [GROUPS[0]] })
    const row = screen.getByRole('button', { name: /compile/ })
    expect(row).toHaveTextContent(/^compile/)
    expect(row).toHaveAttribute('title', 'compile · p-work')
    unmount()
    renderAgents({
      sessions: [{ ...tab('solo', 'g1', [pane('p')]), groupId: undefined }],
    })
    expect(screen.getByRole('button', { name: /solo/ })).toHaveTextContent(
      /^solo$/,
    )
  })

  it('keeps the time right as it passes', () => {
    renderAgents()
    const row = screen.getByRole('button', { name: /compile/ })
    expect(row).toHaveTextContent('3 min ago')
    act(() => vi.advanceTimersByTime(NOW_TICK * 4))
    expect(row).toHaveTextContent('5 min ago')
  })

  it('marks the pane on screen and opens a pane from its row', () => {
    const { onOpen } = renderAgents({ activePaneId: 'p-work' })
    const row = screen.getByRole('button', { name: /compile/ })
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(screen.getByRole('button', { name: /review/ })).not.toHaveAttribute(
      'aria-current',
    )
    fireEvent.click(row)
    expect(onOpen).toHaveBeenCalledWith(SESSIONS[0], SESSIONS[0].panes![0])
  })

  it('folds to its title and stays so', () => {
    const { unmount } = renderAgents()
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle())
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(within(agents()).queryByRole('list')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(height()).toBe('')
    unmount()
    renderAgents()
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle())
    expect(within(agents()).getAllByRole('list')).toHaveLength(3)
  })

  it('resizes from the keyboard, saved at once', () => {
    renderAgents()
    expect(height()).toBe(px(AGENTS_HEIGHT_DEFAULT))
    expect(handle()).toHaveAttribute(
      'aria-valuenow',
      String(AGENTS_HEIGHT_DEFAULT),
    )
    expect(handle()).toHaveAttribute('aria-valuemin', String(AGENTS_HEIGHT_MIN))
    expect(handle()).not.toHaveAttribute('aria-valuemax')
    fireEvent.keyDown(handle(), { key: 'ArrowUp' })
    expect(height()).toBe(px(AGENTS_HEIGHT_DEFAULT + AGENTS_HEIGHT_STEP))
    fireEvent.keyDown(handle(), { key: 'ArrowDown' })
    fireEvent.keyDown(handle(), { key: 'ArrowDown' })
    expect(height()).toBe(px(AGENTS_HEIGHT_DEFAULT - AGENTS_HEIGHT_STEP))
    expect(localStorage.getItem('sidebar-agents-height')).toBe(
      String(AGENTS_HEIGHT_DEFAULT - AGENTS_HEIGHT_STEP),
    )
    fireEvent.keyDown(handle(), { key: 'Home' })
    expect(height()).toBe(px(AGENTS_HEIGHT_MIN))
    // At the least already: nothing to save
    const save = vi.spyOn(Storage.prototype, 'setItem')
    fireEvent.keyDown(handle(), { key: 'ArrowDown' })
    expect(save).not.toHaveBeenCalled()
    // No limit known (no ResizeObserver): End and other keys do nothing
    fireEvent.keyDown(handle(), { key: 'End' })
    fireEvent.keyDown(handle(), { key: 'a' })
    expect(height()).toBe(px(AGENTS_HEIGHT_MIN))
    // Double click: back to the default
    fireEvent.doubleClick(handle())
    expect(height()).toBe(px(AGENTS_HEIGHT_DEFAULT))
  })

  it('resizes by dragging, saved on release', () => {
    renderAgents()
    // Not the main button: no drag
    fireEvent.pointerDown(handle(), { button: 2, clientY: 500 })
    fireEvent.pointerMove(handle(), { clientY: 400 })
    expect(height()).toBe(px(AGENTS_HEIGHT_DEFAULT))
    fireEvent.pointerDown(handle(), { button: 0, clientY: 500 })
    expect(handle().className).toContain('bg-accent/40')
    fireEvent.pointerMove(handle(), { clientY: 400 })
    expect(height()).toBe(px(AGENTS_HEIGHT_DEFAULT + 100))
    expect(localStorage.getItem('sidebar-agents-height')).toBeNull()
    fireEvent.pointerUp(handle())
    expect(localStorage.getItem('sidebar-agents-height')).toBe(
      String(AGENTS_HEIGHT_DEFAULT + 100),
    )
    // A second release, or a drag that ends where it began, saves nothing
    fireEvent.pointerUp(handle())
    localStorage.clear()
    fireEvent.pointerDown(handle(), { button: 0, clientY: 500 })
    fireEvent.pointerCancel(handle())
    expect(localStorage.getItem('sidebar-agents-height')).toBeNull()
    // Down past the least: held at it
    fireEvent.pointerDown(handle(), { button: 0, clientY: 100 })
    fireEvent.pointerMove(handle(), { clientY: 900 })
    fireEvent.lostPointerCapture(handle())
    expect(height()).toBe(px(AGENTS_HEIGHT_MIN))
  })

  it('takes at most 70% of the sidebar, measured as it changes', () => {
    let resize: () => void = () => {}
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          resize = cb
        }
        observe() {}
        disconnect() {}
      },
    )
    let room = 1000
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
      () => room,
    )
    localStorage.setItem('sidebar-agents-height', '900')
    const { unmount } = renderAgents()
    expect(height()).toBe('700px')
    expect(handle()).toHaveAttribute('aria-valuemax', '700')
    room = 400
    act(() => resize())
    expect(height()).toBe('280px')
    fireEvent.keyDown(handle(), { key: 'Home' })
    fireEvent.keyDown(handle(), { key: 'End' })
    expect(height()).toBe('280px')
    // A tiny sidebar still leaves the least
    room = 50
    act(() => resize())
    expect(height()).toBe(px(AGENTS_HEIGHT_MIN))
    unmount()
  })

  it('starts at the default for a saved height it cannot use', () => {
    localStorage.setItem('sidebar-agents-height', 'tall')
    renderAgents()
    expect(height()).toBe(px(AGENTS_HEIGHT_DEFAULT))
  })

  it('works on without storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    renderAgents()
    expect(height()).toBe(px(AGENTS_HEIGHT_DEFAULT))
    fireEvent.keyDown(handle(), { key: 'ArrowUp' })
    expect(height()).toBe(px(AGENTS_HEIGHT_DEFAULT + AGENTS_HEIGHT_STEP))
  })
})
