import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DiscardTabDialog } from './tab-close-dialogs'

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '')
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  })
})

describe('DiscardTabDialog', () => {
  it('shows unsafe characters in the name', () => {
    render(
      <DiscardTabDialog
        name={'a‮b.ts'}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    )
    expect(
      screen.getByText('Your changes to a⟨U+202E⟩b.ts will be lost.'),
    ).toBeInTheDocument()
  })
})
