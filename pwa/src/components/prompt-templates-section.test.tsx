import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type PromptTemplate, RequestError } from '../hooks/use-mux-api'
import type { TemplatesState } from '../hooks/use-prompt-templates'
import { PromptTemplatesSection } from './prompt-templates-section'

const store = vi.hoisted(() => ({
  state: {} as TemplatesState,
  refresh: vi.fn(async () => {}),
  remove: vi.fn(),
  previewImport: vi.fn(),
  importAll: vi.fn(),
}))
vi.mock('../hooks/use-prompt-templates', () => ({
  usePromptTemplates: () => ({
    ...store.state,
    refresh: store.refresh,
    remove: store.remove,
    previewImport: store.previewImport,
    importAll: store.importAll,
  }),
}))
const saved = vi.hoisted(() => vi.fn(async (_f: File) => {}))
vi.mock('../utils/download-file', () => ({ saveMadeFile: saved }))
vi.mock('./template-editor', () => ({
  TemplateEditor: (p: {
    template: PromptTemplate | null
    onClose: () => void
  }) => (
    <div data-testid="editor">
      {p.template ? p.template.name : 'new'}
      <button type="button" onClick={p.onClose}>
        CloseEditor
      </button>
    </div>
  ),
}))

const tpl = (id: string, name: string, updated = 'u'): PromptTemplate => ({
  id,
  name,
  text: `${name} text\nmore`,
  updated,
})

function set(templates: PromptTemplate[], over: Partial<TemplatesState> = {}) {
  store.state = {
    templates,
    readOnly: false,
    loaded: true,
    loading: false,
    error: false,
    ...over,
  }
}

// Picks file in the import input
async function importFile(content: string, size?: number) {
  const file = new File([content], 't.json', { type: 'application/json' })
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size })
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Templates file to import'), {
      target: { files: [file] },
    })
  })
}
const json = (templates: { name: string; text: string }[]) =>
  JSON.stringify({ v: 1, templates })

const confirmDialog = () => screen.getByRole('dialog')
const click = (name: string | RegExp) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })

describe('PromptTemplatesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = vi.fn(function (
      this: HTMLDialogElement,
    ) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn()
    set([tpl('1', 'Code review'), tpl('2', 'De\u202eploy')])
  })

  it('reads them again and lists them, with their hidden characters shown', () => {
    render(<PromptTemplatesSection />)
    expect(store.refresh).toHaveBeenCalled()
    const rows = within(
      screen.getByRole('list', { name: 'Prompt templates' }),
    ).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      'Code reviewCode review textEditDelete',
      'De⟨U+202E⟩ployDe⟨U+202E⟩ploy textEditDelete',
    ])
    expect(
      screen.getByRole('button', { name: 'Edit De⟨U+202E⟩ploy' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/an import cannot be undone/)).toBeInTheDocument()
  })

  it('says when there are none, or they cannot be read', () => {
    set([])
    const { unmount } = render(<PromptTemplatesSection />)
    expect(screen.getByText('No templates yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    unmount()
    set([], { loaded: false, error: true })
    render(<PromptTemplatesSection />)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read the templates',
    )
  })

  it('opens the editor for a new one or one to change', () => {
    render(<PromptTemplatesSection />)
    fireEvent.click(screen.getByRole('button', { name: 'New template' }))
    expect(screen.getByTestId('editor')).toHaveTextContent('new')
    fireEvent.click(screen.getByRole('button', { name: 'CloseEditor' }))
    expect(screen.queryByTestId('editor')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Code review' }))
    expect(screen.getByTestId('editor')).toHaveTextContent('Code review')
  })

  it('a view-only device, or a newer file, only lists and exports', () => {
    const { unmount } = render(<PromptTemplatesSection readOnly />)
    expect(
      screen.getByText(/view only: the templates can be read/),
    ).toBeInTheDocument()
    for (const name of [/^Edit/, /^Delete/, 'New template', 'Import…'])
      expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.queryByLabelText('Templates file to import')).toBeNull()
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
    unmount()
    set([tpl('1', 'a')], { readOnly: true })
    render(<PromptTemplatesSection />)
    expect(screen.getByText(/Saved by a newer Termote/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New template' })).toBeNull()
  })

  it('deletes after asking, naming the version shown', async () => {
    store.remove.mockResolvedValue(undefined)
    render(<PromptTemplatesSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Code review' }))
    expect(confirmDialog()).toHaveAccessibleName('Delete Code review?')
    await click('Delete')
    expect(store.remove).toHaveBeenCalledWith(tpl('1', 'Code review'))
    expect(screen.getByRole('status')).toHaveTextContent('Deleted Code review')
  })

  it('cancelled, nothing is deleted', () => {
    render(<PromptTemplatesSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Code review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(store.remove).not.toHaveBeenCalled()
  })

  it('changed elsewhere: asks again with it as it is now', async () => {
    const now = tpl('1', 'Code review', 'u2')
    store.remove
      .mockRejectedValueOnce(
        new RequestError(409, 'conflict', 'x', { template: now }),
      )
      .mockResolvedValueOnce(undefined)
    render(<PromptTemplatesSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Code review' }))
    await click('Delete')
    expect(confirmDialog()).toHaveAccessibleName(
      'Changed on another device: delete anyway?',
    )
    await click('Delete')
    expect(store.remove).toHaveBeenLastCalledWith(now)
  })

  it('deleted elsewhere is deleted; another refusal is told', async () => {
    store.remove.mockRejectedValueOnce(new RequestError(404, 'not_found', 'x'))
    render(<PromptTemplatesSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Code review' }))
    await click('Delete')
    expect(screen.getByRole('status')).toHaveTextContent('Deleted Code review')
    expect(store.refresh).toHaveBeenCalledTimes(2)
    store.remove.mockRejectedValueOnce(new RequestError(503, 'busy', 'x'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete Code review' }))
    await click('Delete')
    expect(screen.getByRole('alert')).toHaveTextContent('try again')
  })

  it('exports names and texts as JSON', async () => {
    render(<PromptTemplatesSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    const file = saved.mock.calls[0][0]
    expect(file.name).toMatch(/^termote-templates-\d{4}-\d{2}-\d{2}\.json$/)
    expect(file.type).toBe('application/json')
    expect(JSON.parse(await file.text())).toEqual({
      v: 1,
      templates: [
        { name: 'Code review', text: 'Code review text\nmore' },
        { name: 'De\u202eploy', text: 'De\u202eploy text\nmore' },
      ],
    })
  })

  it('imports after listing what the server says it adds and replaces', async () => {
    store.previewImport.mockResolvedValue({
      added: ['Fresh'],
      replaced: ['code review'],
    })
    store.importAll.mockResolvedValue({ added: 1, replaced: 1 })
    render(<PromptTemplatesSection />)
    const picker = screen.getByLabelText('Templates file to import')
    const clicked = vi.spyOn(picker, 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Import…' }))
    expect(clicked).toHaveBeenCalled()
    const list = [
      { name: 'Fresh', text: 'f' },
      { name: 'code review', text: 'c' },
    ]
    await importFile(json(list))
    expect(store.previewImport).toHaveBeenCalledWith(list)
    expect(
      within(confirmDialog()).getByRole('list', { name: 'New' }),
    ).toHaveTextContent('Fresh')
    expect(
      within(confirmDialog()).getByRole('list', {
        name: 'Replaces the existing template',
      }),
    ).toHaveTextContent('code review')
    await click('Import')
    expect(store.importAll).toHaveBeenCalledWith(list, ['code review'])
    expect(screen.getByRole('status')).toHaveTextContent(
      'Imported: 1 added, 1 replaced',
    )
  })

  it('changed since the check: checks again and asks again', async () => {
    store.previewImport
      .mockResolvedValueOnce({ added: ['a'], replaced: [] })
      .mockResolvedValueOnce({ added: [], replaced: ['a'] })
    store.importAll.mockRejectedValueOnce(
      new RequestError(409, 'import_changed', 'x'),
    )
    render(<PromptTemplatesSection />)
    await importFile(json([{ name: 'a', text: 'b' }]))
    await click('Import')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'changed since the check',
    )
    expect(
      within(confirmDialog()).getByRole('list', {
        name: 'Replaces the existing template',
      }),
    ).toHaveTextContent('a')
    expect(
      within(confirmDialog()).queryByRole('list', { name: 'New' }),
    ).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(store.importAll).toHaveBeenCalledTimes(1)
  })

  it('a file that cannot be read, or an export that fails, says so', async () => {
    render(<PromptTemplatesSection />)
    const file = new File(['x'], 't.json')
    file.text = () => Promise.reject(new Error('gone'))
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Templates file to import'), {
        target: { files: [file] },
      })
    })
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not read the file',
    )
    saved.mockRejectedValueOnce(new Error('share failed'))
    await click('Export')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not export the templates',
    )
  })

  it('no second import while one is checked; the editor clears old messages', async () => {
    let answer!: (v: unknown) => void
    store.previewImport.mockReturnValue(new Promise((r) => (answer = r)))
    render(<PromptTemplatesSection />)
    await importFile(json([{ name: 'a', text: 'b' }]))
    expect(screen.getByRole('button', { name: 'Import…' })).toBeDisabled()
    await act(async () => answer({ added: ['a'], replaced: [] }))
    expect(screen.getByRole('button', { name: 'Import…' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await importFile('{')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New template' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a failed delete says so; the focus stays in the list', async () => {
    store.remove.mockRejectedValueOnce(new Error('offline'))
    render(<PromptTemplatesSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete Code review' }))
    await click('Delete')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not delete the template',
    )
    expect(screen.getByRole('button', { name: 'New template' })).toHaveFocus()
  })

  it('says what is wrong with a file or an import the server refuses', async () => {
    render(<PromptTemplatesSection />)
    await importFile('{', 10)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This is not a JSON file',
    )
    await importFile('{}', 5 * 1024 * 1024)
    expect(screen.getByRole('alert')).toHaveTextContent('larger than 4 MB')
    store.previewImport.mockRejectedValueOnce(
      new RequestError(400, 'invalid_template', 'the name is empty', {
        index: 1,
      }),
    )
    await importFile(json([{ name: 'a', text: 'b' }]))
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Template 2: Not saved: the name is empty',
    )
    store.previewImport.mockRejectedValueOnce(
      new RequestError(409, 'too_many', 'x'),
    )
    await importFile(json([{ name: 'a', text: 'b' }]))
    expect(screen.getByRole('alert')).toHaveTextContent('Up to 100 templates')
    store.previewImport.mockResolvedValueOnce({ added: ['a'], replaced: [] })
    store.importAll.mockRejectedValueOnce(new RequestError(503, 'busy', 'x'))
    await importFile(json([{ name: 'a', text: 'b' }]))
    await click('Import')
    expect(screen.getByRole('alert')).toHaveTextContent('try again')
    // No file chosen: nothing
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Templates file to import'), {
        target: { files: [] },
      })
    })
    expect(store.previewImport).toHaveBeenCalledTimes(3)
  })
})
