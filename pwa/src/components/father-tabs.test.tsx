import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '../types/session'
import { fatherTabsOf } from '../utils/father-tab'
import { FatherTabs } from './father-tabs'

const tab = (id: string, name: string, extra: Partial<Session> = {}) =>
  ({ id, name, icon: '', description: '', ...extra }) as Session

const FATHERS = fatherTabsOf([
  tab('1', 'review/PR 1', { agentStatus: 'blocked' }),
  tab('2', 'review/PR 2'),
  tab('3', 'Shell'),
  tab('4', 'coding/api'),
])

const renderRow = (active?: string) => {
  const onSelect = vi.fn()
  render(<FatherTabs fathers={FATHERS} active={active} onSelect={onSelect} />)
  return onSelect
}
const names = () =>
  screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))

describe('FatherTabs', () => {
  it('lists the FatherTabs, the tabs in none as Other, the picked one selected', () => {
    renderRow('review')
    expect(screen.getByRole('tablist', { name: 'FatherTabs' })).toBeVisible()
    expect(names()).toEqual(['review', 'Other', 'coding'])
    expect(screen.getByRole('tab', { name: /review/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('tab', { name: /coding/ })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })

  it('selects Other while the tab on screen is in no FatherTab', () => {
    renderRow()
    expect(screen.getByRole('tab', { name: /Other/ })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('shows how many tabs each has and the heaviest status', () => {
    renderRow('review')
    const review = screen.getByRole('tab', { name: /review/ })
    expect(review).toHaveTextContent('review2')
    expect(review).toHaveAttribute('title', 'review · 2 sessions')
    expect(review.querySelector('[data-status="blocked"]')).not.toBeNull()
    expect(screen.getByRole('tab', { name: /coding/ })).toHaveAttribute(
      'title',
      'coding · 1 session',
    )
  })

  it('picks a FatherTab on a click', () => {
    const onSelect = renderRow('review')
    fireEvent.click(screen.getByRole('tab', { name: /coding/ }))
    expect(onSelect).toHaveBeenCalledWith(FATHERS[2])
  })

  it('moves the focus with the arrow keys, Home and End, around the ends', () => {
    renderRow('review')
    const [review, other, coding] = screen.getAllByRole('tab')
    review.focus()
    fireEvent.keyDown(review, { key: 'ArrowRight' })
    expect(other).toHaveFocus()
    fireEvent.keyDown(other, { key: 'End' })
    expect(coding).toHaveFocus()
    fireEvent.keyDown(coding, { key: 'ArrowRight' })
    expect(review).toHaveFocus()
    fireEvent.keyDown(review, { key: 'ArrowLeft' })
    expect(coding).toHaveFocus()
    fireEvent.keyDown(coding, { key: 'ArrowLeft' })
    expect(other).toHaveFocus()
    fireEvent.keyDown(other, { key: 'Home' })
    expect(review).toHaveFocus()
    // Any other key is left alone
    fireEvent.keyDown(review, { key: 'a' })
    expect(review).toHaveFocus()
  })

  it('names each FatherTab for a drop, the tabs in none by an empty name', () => {
    renderRow('review')
    expect(
      screen.getAllByRole('tab').map((t) => t.getAttribute('data-father')),
    ).toEqual(['review', '', 'coding'])
  })

  it('has no New FatherTab button without onAdd', () => {
    renderRow('review')
    expect(screen.queryByRole('button', { name: 'New FatherTab' })).toBeNull()
  })

  it('asks for a new FatherTab and its first tab, offering those there are', () => {
    const onAdd = vi.fn()
    render(
      <FatherTabs
        fathers={FATHERS}
        active="review"
        onSelect={vi.fn()}
        onAdd={onAdd}
      />,
    )
    const add = screen.getByRole('button', { name: 'New FatherTab' })
    expect(add).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(add)
    expect(add).toHaveAttribute('aria-expanded', 'true')
    const form = screen.getByRole('form', { name: 'New session' })
    const father = within(form).getByRole('combobox', {
      name: 'FatherTab (optional)',
    })
    expect(father).toHaveFocus()
    expect(father).toHaveValue('')
    expect(
      [...form.querySelectorAll('datalist option')].map((o) =>
        o.getAttribute('value'),
      ),
    ).toEqual(['review', 'coding'])
    fireEvent.change(father, { target: { value: ' specs ' } })
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
    render(
      <FatherTabs
        fathers={FATHERS}
        active="review"
        onSelect={vi.fn()}
        onAdd={vi.fn()}
      />,
    )
    const add = screen.getByRole('button', { name: 'New FatherTab' })
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
