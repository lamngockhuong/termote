import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import { FileEditor, saveErrorOf } from './file-editor'

describe('saveErrorOf', () => {
  it.each([
    [new Error('offline'), { kind: 'unsure' }],
    [
      new RequestError(409, '', 'x', undefined, undefined, '/n'),
      { kind: 'root', root: '/n' },
    ],
    [new RequestError(409, 'changed', 'x'), { kind: 'changed' }],
    [
      new RequestError(403, 'sensitive', 'x'),
      { kind: 'refused', message: 'Show the file before saving it' },
    ],
    [
      new RequestError(422, 'not_editable', 'x'),
      { kind: 'refused', message: "This file can't be edited here" },
    ],
    [
      new RequestError(422, 'not_text', 'x'),
      {
        kind: 'refused',
        message: 'Only UTF-8 text without NUL characters can be saved',
      },
    ],
    [
      new RequestError(429, 'busy', 'x'),
      { kind: 'refused', message: 'Too many saves at once. Try again' },
    ],
    [
      new RequestError(403, '', 'path not allowed'),
      { kind: 'refused', message: "This file can't be written" },
    ],
    [
      new RequestError(500, '', 'x'),
      { kind: 'refused', message: 'Could not save the file' },
    ],
  ])('%s', (err, want) => {
    expect(saveErrorOf(err)).toEqual(want)
  })
})

describe('FileEditor', () => {
  const props = {
    path: 'a.txt',
    text: 'x',
    onChange: vi.fn(),
    wrap: false,
    saving: false,
    rootMoved: false,
    dirty: true,
    onSave: vi.fn(),
    onReload: vi.fn(),
    onCopy: vi.fn(),
  }

  it('is a plain textarea that does not correct what is typed', () => {
    render(<FileEditor {...props} wrap />)
    const box = screen.getByRole('textbox', { name: 'Text of a.txt' })
    expect(box).toHaveAttribute('wrap', 'soft')
    expect(box).toHaveAttribute('spellcheck', 'false')
    expect(box).toHaveAttribute('autocapitalize', 'off')
    expect(box).toHaveClass('pointer-coarse:text-[16px]')
    fireEvent.change(box, { target: { value: 'y' } })
    expect(props.onChange).toHaveBeenCalledWith('y')
  })

  it('Ctrl+S saves only when there is something to save', () => {
    const onSave = vi.fn()
    const view = render(<FileEditor {...props} onSave={onSave} dirty={false} />)
    const box = screen.getByRole('textbox')
    fireEvent.keyDown(box, { key: 's', ctrlKey: true })
    expect(onSave).not.toHaveBeenCalled()
    view.rerender(<FileEditor {...props} onSave={onSave} />)
    // Another key, or s alone, does nothing
    fireEvent.keyDown(box, { key: 'a', ctrlKey: true })
    fireEvent.keyDown(box, { key: 's' })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'S', metaKey: true })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('shows a refusal as a danger banner', () => {
    render(
      <FileEditor
        {...props}
        error={{ kind: 'refused', message: 'Could not save the file' }}
      />,
    )
    expect(screen.getByRole('status')).toHaveAttribute('data-variant', 'danger')
    expect(screen.getByText('Could not save the file')).toBeInTheDocument()
  })
})
