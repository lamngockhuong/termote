import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CompactGroupRow } from './compact-group-row'

type Props = ComponentProps<typeof CompactGroupRow>

const renderRow = (over: Partial<Props> = {}) => {
  const props: Props = {
    group: { id: 'w1', name: 'termote' },
    active: false,
    nested: false,
    tabCount: 3,
    collapsible: false,
    collapsed: false,
    onToggle: vi.fn(),
    onSelect: vi.fn(),
    ...over,
  }
  render(<CompactGroupRow {...props} />)
  return props
}
const main = () =>
  screen.getByRole('button', {
    name: /ter|feat/,
    current: undefined,
  }) as HTMLElement

describe('CompactGroupRow', () => {
  it('names the workspace, its tab count and status, its letter hidden', () => {
    renderRow({ status: 'blocked' })
    expect(main()).toHaveAccessibleName('termote, 3 tabs, Agent blocked')
    const avatar = main().querySelector('[aria-hidden="true"]')!
    expect(avatar).toHaveTextContent('T')
    expect(avatar.className).toMatch(/bg-avatar-[1-8]/)
    expect(main()).not.toHaveAttribute('aria-current')
  })

  it('says one tab in the singular', () => {
    renderRow({ tabCount: 1 })
    expect(main()).toHaveAccessibleName('termote, 1 tab')
  })

  it('marks the workspace on screen', () => {
    renderRow({ active: true })
    expect(main()).toHaveAttribute('aria-current', 'true')
    expect(main().parentElement!.className).toContain('bg-accent-soft')
  })

  it('shows a checkout branch on the right, in the tooltip too', () => {
    renderRow({
      group: {
        id: 'w1',
        name: 'termote',
        worktree: { linked: false, branch: 'main' },
      },
    })
    expect(main()).toHaveAccessibleName('termote, 3 tabs, branch main')
    expect(main()).toHaveAttribute('title', 'termote\nmain')
  })

  it('names a worktree by its branch, indented with a branch icon', () => {
    renderRow({
      nested: true,
      group: {
        id: 'w2',
        name: 'termote-wt',
        worktree: { linked: true, parent: 'w1', branch: 'feat/x' },
      },
    })
    expect(main()).toHaveAccessibleName('feat/x, 3 tabs')
    expect(main().parentElement!.className).toContain('ml-3 border-l')
    expect(main().querySelector('.lucide-git-branch')).not.toBeNull()
  })

  it('names a worktree without a branch by its name', () => {
    renderRow({
      nested: true,
      group: { id: 'w2', name: 'wt', worktree: { linked: true, parent: 'w1' } },
    })
    expect(
      screen.getByRole('button', { name: 'wt, 3 tabs' }),
    ).toBeInTheDocument()
  })

  it('shows the hidden characters of a name', () => {
    renderRow({ group: { id: 'w1', name: 'ter‮mote' } })
    expect(main()).toHaveTextContent('ter⟨U+202E⟩mote')
  })

  it('falls back to the id for a group without a name', () => {
    renderRow({ group: { id: 'termote-id', name: '' } })
    expect(main()).toHaveTextContent('termote-id')
  })

  it('selects, renames on double click and passes keys on', () => {
    const onKeyDown = vi.fn()
    const onRename = vi.fn()
    const buttonRef = vi.fn()
    const p = renderRow({
      onRename,
      onKeyDown,
      buttonRef,
      keyShortcuts: 'Alt+ArrowUp Alt+ArrowDown',
    })
    fireEvent.click(main())
    expect(p.onSelect).toHaveBeenCalled()
    fireEvent.doubleClick(main())
    expect(onRename).toHaveBeenCalled()
    fireEvent.keyDown(main(), { key: 'ArrowUp', altKey: true })
    expect(onKeyDown).toHaveBeenCalled()
    expect(buttonRef).toHaveBeenCalledWith(main())
    expect(main()).toHaveAttribute(
      'aria-keyshortcuts',
      'Alt+ArrowUp Alt+ArrowDown',
    )
  })

  it('has a chevron only on a checkout with worktrees', () => {
    renderRow()
    expect(
      screen.queryByRole('button', { name: 'Worktrees of termote' }),
    ).toBeNull()
  })

  it('shows or hides the worktrees from its chevron', () => {
    const p = renderRow({ collapsible: true })
    const chevron = screen.getByRole('button', { name: 'Worktrees of termote' })
    expect(chevron).toHaveAttribute('aria-expanded', 'true')
    expect(chevron.querySelector('.lucide-chevron-down')).not.toBeNull()
    fireEvent.click(chevron)
    expect(p.onToggle).toHaveBeenCalled()
  })

  it('points the chevron right while collapsed', () => {
    renderRow({ collapsible: true, collapsed: true })
    const chevron = screen.getByRole('button', { name: 'Worktrees of termote' })
    expect(chevron).toHaveAttribute('aria-expanded', 'false')
    expect(chevron.querySelector('.lucide-chevron-right')).not.toBeNull()
  })

  it('holds the menu it is given, hidden until hover or focus', () => {
    renderRow({ menu: <button type="button">Menu</button> })
    const holder = screen.getByRole('button', { name: 'Menu' }).parentElement!
    expect(holder.className).toContain('opacity-0')
    expect(holder.className).toContain('group-focus-within/crow:opacity-100')
  })
})
