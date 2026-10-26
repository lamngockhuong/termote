import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type PromptTemplate, RequestError } from '../hooks/use-mux-api'
import { TemplateEditor } from './template-editor'

const store = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}))
vi.mock('../hooks/use-prompt-templates', () => ({
  createPromptTemplate: store.create,
  updatePromptTemplate: store.update,
}))

const tpl = (over: Partial<PromptTemplate> = {}): PromptTemplate => ({
  id: 'a',
  name: 'Review',
  text: 'Review {{file}}',
  updated: 'u1',
  ...over,
})

function renderEditor(template: PromptTemplate | null = null) {
  const onClose = vi.fn()
  render(<TemplateEditor template={template} onClose={onClose} />)
  return { onClose }
}

const nameBox = () => screen.getByRole('textbox', { name: 'Name' })
const textBox = () => screen.getByRole('textbox', { name: 'Text' })
const save = () =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })

describe('TemplateEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    store.create.mockResolvedValue(tpl())
    store.update.mockResolvedValue(tpl())
  })

  it('makes a new template', async () => {
    const { onClose } = renderEditor()
    expect(
      screen.getByRole('dialog', { name: 'New prompt template' }),
    ).toBeVisible()
    expect(nameBox()).toHaveFocus()
    fireEvent.change(nameBox(), { target: { value: 'Deploy' } })
    fireEvent.change(textBox(), { target: { value: 'ship {{branch}}' } })
    expect(screen.getByText('1 KB of 16 KB')).toBeInTheDocument()
    await save()
    expect(store.create).toHaveBeenCalledWith({
      name: 'Deploy',
      text: 'ship {{branch}}',
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('changes one, naming the version it read', async () => {
    const { onClose } = renderEditor(tpl({ name: 'Re\u202eview' }))
    expect(
      screen.getByRole('dialog', { name: 'Edit Re⟨U+202E⟩view' }),
    ).toBeVisible()
    fireEvent.change(nameBox(), { target: { value: 'Review' } })
    await save()
    expect(store.update).toHaveBeenCalledWith('a', {
      name: 'Review',
      text: 'Review {{file}}',
      updated: 'u1',
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('checks before sending: name, size, hidden characters', async () => {
    renderEditor()
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent('Name the template')
    fireEvent.change(nameBox(), { target: { value: 'n' } })
    fireEvent.change(textBox(), { target: { value: 'é'.repeat(9000) } })
    expect(screen.getByText('18 KB of 16 KB')).toHaveClass('text-danger')
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent('larger than 16 KB')
    fireEvent.change(textBox(), { target: { value: 'a\u200bb' } })
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent('U+200B at character 2')
    expect(store.create).not.toHaveBeenCalled()
  })

  it('puts a variable where the caret is', async () => {
    renderEditor()
    fireEvent.change(textBox(), { target: { value: 'ab' } })
    ;(textBox() as HTMLTextAreaElement).setSelectionRange(1, 1)
    fireEvent.click(
      screen.getByRole('button', { name: /^Insert \{\{selection\}\}/ }),
    )
    expect(textBox()).toHaveValue('a{{selection}}b')
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))))
    expect(textBox()).toHaveFocus()
    expect((textBox() as HTMLTextAreaElement).selectionStart).toBe(14)
  })

  it.each([
    ['name_taken', 'A template with this name exists'],
    ['too_many', 'Up to 100 templates'],
    ['newer_format', 'Saved by a newer Termote'],
    ['busy', 'try again'],
  ])('says why the server refused: %s', async (code, text) => {
    store.create.mockRejectedValue(new RequestError(409, code, 'x'))
    renderEditor()
    fireEvent.change(nameBox(), { target: { value: 'n' } })
    fireEvent.change(textBox(), { target: { value: 't' } })
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(text)
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('marks the field an error is about', async () => {
    renderEditor()
    await save()
    expect(nameBox()).toHaveAttribute('aria-invalid', 'true')
    expect(nameBox()).toHaveAccessibleDescription('Name the template')
    fireEvent.change(nameBox(), { target: { value: 'n' } })
    fireEvent.change(textBox(), { target: { value: 't' } })
    store.create.mockRejectedValueOnce(
      new RequestError(400, 'invalid_template', 'the text is empty', {
        field: 'text',
      }),
    )
    await save()
    expect(nameBox()).not.toHaveAttribute('aria-invalid')
    expect(textBox()).toHaveAttribute('aria-invalid', 'true')
    expect(textBox()).toHaveAccessibleDescription(
      '1 KB of 16 KB Not saved: the text is empty',
    )
  })

  it('changed on another device: load theirs, or keep mine over it', async () => {
    const theirs = tpl({ name: 'Theirs', text: 'their text', updated: 'u2' })
    store.update.mockRejectedValueOnce(
      new RequestError(409, 'conflict', 'x', { template: theirs }),
    )
    const { onClose } = renderEditor(tpl())
    fireEvent.change(textBox(), { target: { value: 'mine' } })
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Changed on another device',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Load theirs' }))
    expect(nameBox()).toHaveValue('Theirs')
    expect(textBox()).toHaveValue('their text')
    // Saved again over theirs: the version read now is theirs
    fireEvent.change(textBox(), { target: { value: 'mine again' } })
    await save()
    expect(store.update).toHaveBeenLastCalledWith('a', {
      name: 'Theirs',
      text: 'mine again',
      updated: 'u2',
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('keep mine saves my text over theirs', async () => {
    const theirs = tpl({ updated: 'u2' })
    store.update.mockRejectedValueOnce(
      new RequestError(409, 'conflict', 'x', { template: theirs }),
    )
    renderEditor(tpl())
    fireEvent.change(textBox(), { target: { value: 'mine' } })
    await save()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    })
    expect(store.update).toHaveBeenLastCalledWith('a', {
      name: 'Review',
      text: 'mine',
      updated: 'u2',
    })
  })

  it('deleted on another device: save as new', async () => {
    store.update.mockRejectedValueOnce(new RequestError(404, 'not_found', 'x'))
    const { onClose } = renderEditor(tpl())
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Deleted on another device',
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save as new' }))
    })
    expect(store.create).toHaveBeenCalledWith({
      name: 'Review',
      text: 'Review {{file}}',
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('a refusal that is not the server code says it could not save', async () => {
    store.create.mockRejectedValue(new Error('offline'))
    renderEditor()
    fireEvent.change(nameBox(), { target: { value: 'n' } })
    fireEvent.change(textBox(), { target: { value: 't' } })
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not save the templates',
    )
    // A conflict without the template is no conflict to offer
    store.create.mockRejectedValue(new RequestError(409, 'conflict', 'x'))
    await save()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Changed on another device',
    )
    expect(screen.queryByRole('button', { name: 'Load theirs' })).toBeNull()
  })

  it('cancels', () => {
    const { onClose } = renderEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
