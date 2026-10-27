import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RequestError } from '../hooks/use-mux-api'
import type { TextLines } from '../utils/line-range'
import type { CodeEditorProps } from './code-editor'
import { FileEditor, SaveBanner, saveErrorOf } from './file-editor'

// The desktop editor's chunk: a stand-in that shows what it was given, or
// fails to load while fail is set
const chunk = vi.hoisted(() => ({ fail: false }))
vi.mock('./code-editor', () => {
  if (chunk.fail) throw new Error('offline')
  return {
    default: (p: CodeEditorProps) => (
      <div data-testid="code-editor" data-can-save={p.canSave}>
        {p.path} {p.at?.line}
      </div>
    ),
  }
})

describe('saveErrorOf', () => {
  it.each([
    [new Error('offline'), { kind: 'unsure' }],
    [
      new RequestError(409, '', 'x', { root: '/n' }),
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
      new RequestError(507, 'storage_full', 'x'),
      { kind: 'refused', message: "The host's disk or quota is full" },
    ],
    [
      new RequestError(403, 'read_only', 'x'),
      { kind: 'refused', message: 'The file system there is read-only' },
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
    notify: vi.fn(),
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

  it('tells a selection made in the textarea', () => {
    const onSelectText = vi.fn()
    const view = render(
      <FileEditor {...props} text="hello" onSelectText={onSelectText} />,
    )
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    box.setSelectionRange(1, 1)
    fireEvent.select(box)
    expect(onSelectText).not.toHaveBeenCalled()
    box.setSelectionRange(1, 4)
    fireEvent.select(box)
    expect(onSelectText).toHaveBeenCalledWith('ell')
    view.rerender(<FileEditor {...props} text="hello" />)
    fireEvent.select(box)
  })

  it('reads the whole lines selected in the textarea, for a comment', () => {
    const linesRef: { current: (() => TextLines) | null } = { current: null }
    const view = render(
      <FileEditor {...props} text={'a\nb\nc'} linesRef={linesRef} />,
    )
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    box.setSelectionRange(2, 5)
    expect(linesRef.current?.()).toEqual({
      from: 2,
      to: 3,
      lines: ['b', 'c'],
    })
    view.unmount()
    expect(linesRef.current).toBeNull()
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
      <SaveBanner
        error={{ kind: 'refused', message: 'Could not save the file' }}
        rootMoved={false}
        onReload={vi.fn()}
        onCopy={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toHaveAttribute('data-variant', 'danger')
    expect(screen.getByText('Could not save the file')).toBeInTheDocument()
  })
})

describe('FileEditor scroll', () => {
  it('opened hidden, goes to the offset once it shows', () => {
    const ui = (hidden: boolean) => (
      <FileEditor
        path="a.txt"
        text="x"
        onChange={vi.fn()}
        wrap={false}
        saving={false}
        rootMoved={false}
        dirty={false}
        onSave={vi.fn()}
        notify={vi.fn()}
        scrollTop={33}
        hidden={hidden}
      />
    )
    const view = render(ui(true))
    const box = screen.getByRole('textbox', { name: 'Text of a.txt' })
    expect(box.scrollTop).toBe(0)
    view.rerender(ui(false))
    expect(box.scrollTop).toBe(33)
    box.scrollTop = 5
    view.rerender(ui(true))
    view.rerender(ui(false))
    expect(box.scrollTop).toBe(5)
  })

  it('starts at the offset it was left at, marked for the viewer', () => {
    render(
      <FileEditor
        path="a.txt"
        text="x"
        onChange={vi.fn()}
        wrap={false}
        saving={false}
        rootMoved={false}
        dirty={false}
        onSave={vi.fn()}
        notify={vi.fn()}
        scrollTop={33}
      />,
    )
    const box = screen.getByRole('textbox', { name: 'Text of a.txt' })
    expect(box.scrollTop).toBe(33)
    expect(box).toHaveAttribute('data-scroll-restore')
  })
})

describe('FileEditor on a device with a fine pointer', () => {
  const matchMedia = window.matchMedia
  const fine = (query: string) => ({
    ...matchMedia(query),
    matches: query === '(pointer: fine)',
  })
  afterEach(() => {
    window.matchMedia = matchMedia
    chunk.fail = false
  })
  const props = {
    path: 'a.txt',
    text: 'x',
    onChange: vi.fn(),
    wrap: false,
    saving: false,
    rootMoved: false,
    dirty: true,
    onSave: vi.fn(),
    notify: vi.fn(),
  }

  it('falls back to the textarea when the editor cannot load, with Retry', async () => {
    window.matchMedia = fine as typeof matchMedia
    vi.spyOn(console, 'error').mockImplementation(() => {})
    chunk.fail = true
    render(<FileEditor {...props} />)
    expect(await screen.findByText('Could not load the editor')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Text of a.txt' }).tagName).toBe(
      'TEXTAREA',
    )
    chunk.fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('code-editor')).toBeInTheDocument()
    expect(screen.queryByText('Could not load the editor')).toBeNull()
    vi.mocked(console.error).mockRestore()
  })

  it('edits in CodeMirror, saving only when there is something to save', async () => {
    window.matchMedia = fine as typeof matchMedia
    const view = render(<FileEditor {...props} at={{ line: 3, jump: 1 }} />)
    const editor = await screen.findByTestId('code-editor')
    expect(editor).toHaveTextContent('a.txt 3')
    expect(editor).toHaveAttribute('data-can-save', 'true')
    expect(screen.queryByRole('textbox')).toBeNull()
    view.rerender(<FileEditor {...props} rootMoved />)
    expect(editor).toHaveAttribute('data-can-save', 'false')
    view.rerender(<FileEditor {...props} saving />)
    expect(editor).toHaveAttribute('data-can-save', 'false')
    view.rerender(<FileEditor {...props} dirty={false} />)
    expect(editor).toHaveAttribute('data-can-save', 'false')
  })
})
