import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownEditLayout } from './markdown-edit-layout'

function show(mode: 'source' | 'split' | 'preview') {
  return (
    <MarkdownEditLayout
      mode={mode}
      editor={<textarea aria-label="editor" />}
      preview={<div data-testid="markdown-preview" tabIndex={-1} />}
    />
  )
}

describe('MarkdownEditLayout', () => {
  it('shows the editor alone, both side by side, or the preview alone with the editor kept', () => {
    const view = render(show('source'))
    const editor = screen.getByRole('textbox', { name: 'editor' })
    expect(editor).toBeVisible()
    expect(screen.queryByTestId('markdown-preview')).toBeNull()

    view.rerender(show('split'))
    expect(screen.getByRole('textbox', { name: 'editor' })).toBe(editor)
    const preview = screen.getByTestId('markdown-preview')
    expect(preview.parentElement).toHaveClass('border-l')
    expect(editor.parentElement).toHaveClass('flex')

    view.rerender(show('preview'))
    // The same editor, hidden: its undo history is still there
    expect(screen.getByLabelText('editor')).toBe(editor)
    expect(editor.parentElement).toHaveClass('hidden')
    expect(
      screen.getByTestId('markdown-preview').parentElement,
    ).not.toHaveClass('border-l')
  })

  it('gives the preview the focus the hidden editor had', () => {
    const view = render(show('split'))
    const editor = screen.getByRole('textbox', { name: 'editor' })
    editor.focus()
    view.rerender(show('preview'))
    expect(screen.getByTestId('markdown-preview')).toHaveFocus()
  })

  it('takes the focus from the page, and leaves it elsewhere alone', () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    const view = render(show('source'))
    view.rerender(show('preview'))
    expect(screen.getByTestId('markdown-preview')).toHaveFocus()
    view.rerender(show('split'))
    outside.focus()
    view.rerender(show('preview'))
    expect(outside).toHaveFocus()
    // Already showing alone: nothing moves
    view.rerender(show('preview'))
    expect(outside).toHaveFocus()
    outside.remove()
  })
})
