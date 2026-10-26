import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { FindStatus } from '../hooks/use-csv-find'
import { MAX_FIND } from '../utils/csv-find'
import { TableFindBar } from './table-find-bar'

const flags = { matchCase: false, wholeCell: false, regex: false }

function bar(over: Record<string, unknown> = {}) {
  const props = {
    input: 'beta',
    onInput: vi.fn(),
    flags,
    onFlags: vi.fn(),
    status: 'ready' as FindStatus,
    count: 17,
    current: 2,
    hidden: 0,
    onStep: vi.fn(),
    onClose: vi.fn(),
    inputRef: createRef<HTMLInputElement>(),
    ...over,
  }
  render(<TableFindBar {...props} />)
  return props
}

const box = () => screen.getByRole('textbox', { name: 'Find' })

describe('TableFindBar', () => {
  it('offers only the toggles asked for, and names what it finds in', () => {
    bar({ toggles: ['matchCase'], label: 'Find in document', f3: false })
    expect(document.querySelector('search')).toHaveAttribute(
      'aria-label',
      'Find in document',
    )
    expect(screen.getByRole('button', { name: 'Match case' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Whole cell' })).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'Regular expression' }),
    ).toBeNull()
    expect(screen.getByRole('button', { name: 'Next match' })).toHaveAttribute(
      'title',
      'Next match (Enter)',
    )
    expect(
      screen.getByRole('button', { name: 'Previous match' }),
    ).toHaveAttribute('title', 'Previous match (Shift+Enter)')
  })

  it('tells F3 by default', () => {
    bar()
    expect(screen.getByRole('button', { name: 'Next match' })).toHaveAttribute(
      'title',
      'Next match (Enter, F3)',
    )
  })

  it('counts the matches, the current one first, in a live region', () => {
    const p = bar()
    // <search>: the search role in a browser, though not in jsdom
    expect(document.querySelector('search')).toHaveAttribute(
      'aria-label',
      'Find in table',
    )
    expect(screen.getByText('3 of 17')).toHaveAttribute('aria-live', 'polite')
    expect(p.inputRef.current).toBe(box())
  })

  it.each<[FindStatus, number, string]>([
    ['invalid', 0, 'Invalid pattern'],
    ['busy', 0, '…'],
    ['timeout', 0, 'Search took too long'],
    ['failed', 0, 'Search failed'],
    ['unavailable', 0, 'Search is unavailable'],
    ['ready', 0, 'No matches'],
    ['ready', MAX_FIND + 1, `3 of ${MAX_FIND}+`],
  ])('%s with %i matches says "%s"', (status, count, text) => {
    bar({ status, count })
    expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('says nothing with nothing typed, and cannot step without a match', () => {
    bar({ input: '', count: 0 })
    expect(screen.queryByText('No matches')).toBeNull()
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Previous match' }),
    ).toBeDisabled()
  })

  it('tells what is typed and each option toggled', () => {
    const p = bar({ flags: { ...flags, regex: true } })
    fireEvent.change(box(), { target: { value: 'b.t' } })
    expect(p.onInput).toHaveBeenCalledWith('b.t')
    const regex = screen.getByRole('button', { name: 'Regular expression' })
    expect(regex).toHaveAttribute('aria-pressed', 'true')
    expect(regex).toHaveClass('text-accent')
    fireEvent.click(regex)
    expect(p.onFlags).toHaveBeenLastCalledWith(flags)
    const whole = screen.getByRole('button', { name: 'Whole cell' })
    expect(whole).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(whole)
    expect(p.onFlags).toHaveBeenLastCalledWith({
      ...flags,
      regex: true,
      wholeCell: true,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }))
    expect(p.onFlags).toHaveBeenLastCalledWith({
      ...flags,
      regex: true,
      matchCase: true,
    })
  })

  it('Enter and Shift+Enter step, never while composing; the buttons too', () => {
    const p = bar()
    fireEvent.keyDown(box(), { key: 'Enter' })
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box(), { key: 'a' })
    expect(p.onStep.mock.calls).toEqual([[1], [-1]])
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(p.onStep.mock.calls.slice(2)).toEqual([[1], [-1]])
  })

  it('never counts the match past MAX_FIND', () => {
    bar({ count: MAX_FIND + 1, current: MAX_FIND })
    expect(screen.getByText(`${MAX_FIND} of ${MAX_FIND}+`)).toBeInTheDocument()
  })

  it("Escape while composing is the composer's", () => {
    const p = bar()
    fireEvent.keyDown(box(), { key: 'Escape', isComposing: true })
    expect(p.onClose).not.toHaveBeenCalled()
  })

  it('Escape anywhere in it closes, as does the close button', () => {
    const p = bar()
    fireEvent.keyDown(box(), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Match case' }), {
      key: 'Escape',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Close find' }))
    expect(p.onClose).toHaveBeenCalledTimes(3)
  })

  it('shows hidden characters typed, and says hidden columns are not searched', () => {
    bar({ input: '‮1', hidden: 2 })
    expect(screen.getByText('⟨U+202E⟩1')).toBeInTheDocument()
    expect(screen.getByText('Hidden columns not searched')).toBeInTheDocument()
  })

  it('shows no note with nothing hidden', () => {
    bar()
    expect(screen.queryByText('Hidden columns not searched')).toBeNull()
    expect(screen.queryByText('beta', { selector: 'span' })).toBeNull()
  })
})
