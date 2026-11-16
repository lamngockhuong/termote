import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import { tabGroupRows } from '../utils/tab-group'
import { TabGroupRows } from './tab-group-row'

const tab = (id: string, name: string, extra: Partial<Session> = {}) =>
  ({ id, name, icon: '', description: '', ...extra }) as Session

const ROWS = tabGroupRows([
  tab('1', 'review/PR 1', { agentStatus: 'blocked' }),
  tab('2', 'review/PR 2'),
  tab('3', 'Shell'),
  tab('4', 'coding/api'),
])

const renderRow = (active?: string, onAdd?: () => void) => {
  const onSelect = vi.fn()
  render(
    <TabGroupRows
      rows={ROWS}
      active={active}
      onSelect={onSelect}
      onAdd={onAdd}
    />,
  )
  return onSelect
}
const row = (name: RegExp) => screen.getByRole('tab', { name })

describe('TabGroupRows', () => {
  it('lists the groups, the tabs in none as No group, the picked one selected', () => {
    renderRow('review')
    expect(screen.getByRole('tablist', { name: 'Tab groups' })).toBeVisible()
    expect(
      screen
        .getAllByRole('tab')
        .map((t) => t.getAttribute('data-tab-group-row')),
    ).toEqual(['review', '', 'coding'])
    expect(row(/review/)).toHaveAttribute('aria-selected', 'true')
    expect(row(/coding/)).toHaveAttribute('aria-selected', 'false')
    expect(row(/No group/)).toHaveAttribute('aria-selected', 'false')
  })

  it('draws the picked group in its colour, the others with a dot of theirs', () => {
    renderRow('review')
    expect(row(/review/).className).toMatch(/bg-avatar-\d/)
    expect(row(/review/).querySelector('.rounded-full')).toBeNull()
    expect(row(/coding/).className).not.toMatch(/bg-avatar/)
    expect(row(/coding/).querySelector('.rounded-full')!.className).toMatch(
      /bg-avatar-\d/,
    )
    // The tabs in none have no colour
    expect(row(/No group/).querySelector('.rounded-full')).toBeNull()
  })

  it('selects No group while the tab on screen is in none', () => {
    renderRow()
    expect(row(/No group/)).toHaveAttribute('aria-selected', 'true')
    expect(row(/No group/).className).not.toMatch(/bg-avatar/)
  })

  it('shows how many tabs each has and the heaviest status', () => {
    renderRow('review')
    expect(row(/review/)).toHaveTextContent('review2')
    expect(row(/review/)).toHaveAttribute('title', 'review · 2 sessions')
    expect(
      row(/review/).querySelector('[data-status="blocked"]'),
    ).not.toBeNull()
    expect(row(/coding/)).toHaveAttribute('title', 'coding · 1 session')
  })

  it('picks a group on a click', () => {
    const onSelect = renderRow('review')
    fireEvent.click(row(/coding/))
    expect(onSelect).toHaveBeenCalledWith(ROWS[2])
  })

  it('moves the focus with the arrow keys, Home and End, around the ends', () => {
    renderRow('review')
    const [review, none, coding] = screen.getAllByRole('tab')
    review.focus()
    fireEvent.keyDown(review, { key: 'ArrowRight' })
    expect(none).toHaveFocus()
    fireEvent.keyDown(none, { key: 'End' })
    expect(coding).toHaveFocus()
    fireEvent.keyDown(coding, { key: 'ArrowRight' })
    expect(review).toHaveFocus()
    fireEvent.keyDown(review, { key: 'ArrowLeft' })
    expect(coding).toHaveFocus()
    fireEvent.keyDown(coding, { key: 'ArrowLeft' })
    expect(none).toHaveFocus()
    fireEvent.keyDown(none, { key: 'Home' })
    expect(review).toHaveFocus()
    // Any other key is left alone
    fireEvent.keyDown(review, { key: 'a' })
    expect(review).toHaveFocus()
  })

  it('has no New tab group button without onAdd', () => {
    renderRow('review')
    expect(screen.queryByRole('button', { name: 'New tab group' })).toBeNull()
  })

  it('asks for a new group and its first tab, offering those there are', () => {
    const onAdd = vi.fn()
    renderRow('review', onAdd)
    const add = screen.getByRole('button', { name: 'New tab group' })
    expect(add).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(add)
    expect(add).toHaveAttribute('aria-expanded', 'true')
    const form = screen.getByRole('form', { name: 'New session' })
    // Under the row's start, where there is always room
    expect(form).toHaveClass('left-0')
    const group = within(form).getByRole('combobox', {
      name: 'Tab group (optional)',
    })
    expect(group).toHaveFocus()
    expect(group).toHaveValue('')
    expect(
      [...form.querySelectorAll('datalist option')].map((o) =>
        o.getAttribute('value'),
      ),
    ).toEqual(['review', 'coding'])
    fireEvent.change(group, { target: { value: ' specs ' } })
    fireEvent.change(
      within(form).getByRole('textbox', { name: 'Session name' }),
      { target: { value: 'auth' } },
    )
    fireEvent.submit(form)
    expect(onAdd).toHaveBeenCalledWith('specs/auth', undefined)
    // Closed by the form itself: the focus is back on +
    expect(screen.queryByRole('form')).toBeNull()
    expect(add).toHaveFocus()
  })

  it('closes the form on + again, and on a press outside without the focus', () => {
    renderRow('review', vi.fn())
    const add = screen.getByRole('button', { name: 'New tab group' })
    fireEvent.click(add)
    // A press on + is not one outside
    fireEvent.pointerDown(add)
    expect(screen.getByRole('form')).toBeInTheDocument()
    fireEvent.click(add)
    expect(screen.queryByRole('form')).toBeNull()
    expect(add).toHaveFocus()
    fireEvent.click(add)
    add.blur()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('form')).toBeNull()
    expect(add).not.toHaveFocus()
  })
})
