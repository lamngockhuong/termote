import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewTarget } from '../utils/review-draft'
import { ReviewCommentSheet } from './review-comment-sheet'

const on = (over: Partial<ReviewTarget> = {}): ReviewTarget => ({
  root: '/r',
  path: 'src/a.ts',
  source: 'unstaged',
  start: 12,
  end: 18,
  quote: '+added',
  ...over,
})

function show(t: ReviewTarget | null, initialText?: string) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(
    <ReviewCommentSheet
      target={t}
      initialText={initialText}
      onSave={onSave}
      onClose={onClose}
    />,
  )
  return { onSave, onClose }
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn()
})

const box = () => screen.getByRole('textbox', { name: 'Comment' })
const type = (value: string) => fireEvent.change(box(), { target: { value } })

describe('ReviewCommentSheet', () => {
  it('is closed without lines to comment on', () => {
    show(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows where the comment goes and the lines, and adds it', () => {
    const { onSave } = show(on())
    expect(screen.getByText('Add a comment')).toBeInTheDocument()
    expect(screen.getByText('lines 12-18')).toBeInTheDocument()
    expect(screen.getByTestId('review-quote')).toHaveTextContent('+added')
    expect(box()).toHaveFocus()
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    type('  ')
    expect(add).toBeDisabled()
    type('Why?')
    fireEvent.click(add)
    expect(onSave).toHaveBeenCalledWith('Why?')
  })

  it('adds with Ctrl+Enter, not with Enter alone or when empty', () => {
    const { onSave } = show(on())
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true })
    expect(onSave).not.toHaveBeenCalled()
    type('x')
    fireEvent.keyDown(box(), { key: 'Enter' })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.keyDown(box(), { key: 'Enter', metaKey: true })
    expect(onSave).toHaveBeenCalledWith('x')
  })

  it('refuses a comment over 4 KiB', () => {
    show(on())
    type('é'.repeat(2100))
    expect(screen.getByText(/Too long: 4\.1 of 4 KiB/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
  })

  it('never shows the lines of a sensitive file', () => {
    show(on({ sensitive: true, quote: undefined, path: '.env' }))
    expect(
      screen.getByText('Lines not quoted: may contain secrets'),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('review-quote')).toBeNull()
  })

  it('shows no quote it does not have', () => {
    show(on({ quote: undefined }))
    expect(screen.queryByTestId('review-quote')).toBeNull()
  })

  it('edits a comment, and cancels', () => {
    const { onSave, onClose } = show(on(), 'old')
    expect(screen.getByText('Edit comment')).toBeInTheDocument()
    expect(box()).toHaveValue('old')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(onSave).toHaveBeenCalledWith('old')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
